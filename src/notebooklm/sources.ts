/**
 * NotebookLM source ingestion (issue #25).
 *
 * v2.0.0 supports the two source types that cover the bulk of real usage:
 *   - `url`  — paste a website URL (NotebookLM crawls and indexes it)
 *   - `text` — paste raw text (treated as a copied document)
 *
 * File-upload, YouTube and Google-Drive ingestion are intentionally out of
 * scope for v2.0.0 — they require different overlay flows.
 *
 * Robustness strategy (2026-09, verified against the live rebranded UI):
 *
 *   1. Capture the *expected notebook UUID* from the URL up-front. NotebookLM
 *      sometimes redirects pasted-text uploads to a freshly-created notebook;
 *      we detect that and surface a clear error.
 *
 *   2. Resolve the dialog state defensively: if a dialog is already open we
 *      use it; otherwise we click the sidebar "Add source" control. In the
 *      rebranded UI Playwright locator clicks are intercepted by an
 *      invisible cdk backdrop, so after failed locator clicks we fall back
 *      to a direct DOM click via page.evaluate (verified E2E 2026-09).
 *
 *   3. Source-type buttons no longer ship with aria-labels — see
 *      selectors.ts for the icon-/text-based anchors.
 *
 *   4. Insert verification is COUNT-BASED: snapshot
 *      `.single-source-container` count before the submit click, then poll
 *      after the dialog closes (up to 90 s — URL crawls are slow).
 */

import type { Page } from "patchright";
import { Selectors, joinAlt } from "./selectors.js";
import { safeSleep, isRecoverable } from "../browser/watchdog.js";
import { log } from "../utils/logger.js";

export type SourceType = "url" | "text";

export interface AddSourceInput {
  type: SourceType;
  /** URL when `type === "url"`, raw text when `type === "text"`. */
  content: string;
  /** Optional title shown in the source list. NotebookLM uses a default if omitted. */
  title?: string;
}

export interface AddSourceResult {
  success: boolean;
  type: SourceType;
  sourceCountBefore: number;
  sourceCountAfter: number;
  message?: string;
}

export async function addSource(page: Page, input: AddSourceInput): Promise<AddSourceResult> {
  const initialUrl = page.url();
  const expectedUuid = initialUrl.match(/notebook\/([a-f0-9-]+)/)?.[1];
  log.info(`📄 [add_source] type=${input.type} target_uuid=${expectedUuid ?? "?"}`);

  try {
    // 1. Open the Add-source dialog (or use one that's already open).
    await openAddSourceOverlay(page);

    // 2. Pick the source type if there is a picker. Some overlay variants
    //    drop straight into an input field; pickSourceType is a no-op then.
    await pickSourceType(page, input.type);

    // 3. Fill the content + optional title.
    await fillSourceContent(page, input);

    // 4. Snapshot the source count *before* submitting. The Fork captures it
    //    here (dialog still open, sidebar list not yet updated) so the
    //    post-close poll can detect a real increment.
    const before = await countSources(page);
    log.info(`  📊 source count before submit: ${before}`);

    // 5. Click the primary "Insert" / "Hinzufügen" button.
    await confirmInsert(page);

    // 6. Wait for the dialog to animate away. NotebookLM doesn't append the
    //    new sidebar entry until the modal is fully gone.
    await waitForOverlayToClose(page);

    // 7. UUID redirect check: pasted-text uploads occasionally land in a new
    //    "Untitled notebook" instead of the target. Catch that here so the
    //    caller sees a useful error instead of a phantom success.
    if (expectedUuid) {
      const currentUrl = page.url();
      const currentUuid = currentUrl.match(/notebook\/([a-f0-9-]+)/)?.[1];
      if (currentUuid && currentUuid !== expectedUuid) {
        log.error(`  ❌ Notebook redirect: expected ${expectedUuid}, got ${currentUuid}`);
        return {
          success: false,
          type: input.type,
          sourceCountBefore: before,
          sourceCountAfter: before,
          message:
            `NotebookLM redirected to a different notebook (${currentUuid}) instead of ` +
            `the target (${expectedUuid}). This is a known quirk for pasted-text uploads — ` +
            `the source landed in a new "Untitled notebook".`,
        };
      }
    }

    // 8. Poll the source count for up to 90 s; URL crawls and large pastes
    //    can take a while to materialise as a sidebar entry.
    const after = await waitForSourceCountIncrease(page, before, 90_000);

    if (after > before) {
      log.success(`  ✅ source added (count ${before} → ${after})`);
      return {
        success: true,
        type: input.type,
        sourceCountBefore: before,
        sourceCountAfter: after,
      };
    }

    // 9. Last-ditch: maybe an error toast surfaced; surface it verbatim.
    const errorText = await readDialogError(page);
    return {
      success: false,
      type: input.type,
      sourceCountBefore: before,
      sourceCountAfter: after,
      message:
        errorText ||
        "Source dialog completed but the source list did not grow within 90 s. " +
          "Either NotebookLM is still crawling/indexing or the upload silently failed.",
    };
  } catch (err) {
    if (isRecoverable(err)) throw err;
    log.warning(`  ⚠️  add_source failed: ${err}`);
    return {
      success: false,
      type: input.type,
      sourceCountBefore: 0,
      sourceCountAfter: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Count sources in the sidebar via two independent anchors:
 *
 *   1. `.single-source-container` — the per-row sidebar element. Most
 *      direct, but only present once the sidebar has hydrated.
 *
 *   2. `.cover-subtitle-source-count` — a header label of the form
 *      `"3 Quellen"` / `"3 sources"`. Robust to a collapsed or partially
 *      hydrated sidebar because it lives in the chat header instead.
 *
 * We return whichever produces a higher count; mismatches between the two
 * usually mean the sidebar hasn't caught up yet, in which case the header
 * is the authoritative ground truth.
 */
export async function countSources(page: Page): Promise<number> {
  let containerCount = 0;
  try {
    containerCount = await page.locator(Selectors.sources.sourceContainer).count();
  } catch {
    /* fall through */
  }

  let headerCount = 0;
  try {
    const headerText = await page
      .locator(".cover-subtitle-source-count")
      .first()
      .textContent({ timeout: 500 })
      .catch(() => null);
    const match = headerText?.match(/(\d+)/);
    if (match) headerCount = parseInt(match[1], 10);
  } catch {
    /* ignore */
  }

  return Math.max(containerCount, headerCount);
}

/**
 * Dismiss lingering CDK overlays before interacting with the page.
 *
 * The rebranded notebook.google.com UI leaves `cdk-overlay-popover`
 * (e.g. the Korean quota-information popover) and `cdk-overlay-backdrop`
 * elements mounted after a dialog closes. They intercept pointer events,
 * so the Add-source button click is swallowed. Remedy: press Escape, then
 * force-click the backdrop as a fallback. Safe no-op when nothing blocks.
 */
export async function dismissOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const popover = page.locator(".cdk-overlay-popover").first();
    const backdrop = page.locator(".cdk-overlay-backdrop").first();
    const popoverVisible = await popover.isVisible({ timeout: 300 }).catch(() => false);
    const backdropVisible = await backdrop.isVisible({ timeout: 300 }).catch(() => false);

    if (!popoverVisible && !backdropVisible) return;

    log.info(`  🚪 Dismissing lingering CDK overlay (attempt ${attempt + 1})…`);
    await page.keyboard.press("Escape").catch(() => undefined);
    await safeSleep(page, 300);

    if (await backdrop.isVisible({ timeout: 200 }).catch(() => false)) {
      await backdrop.click({ force: true, timeout: 1_000 }).catch(() => undefined);
      await safeSleep(page, 300);
    }
  }
}

/**
 * Open the Add-source modal. Order of attempts:
 *   0. Dismiss any lingering CDK popover/backdrop that would swallow clicks.
 *   1. Dialog already open → use it (auto-modal on fresh notebooks).
 *   2. Click the sidebar "Add source" control (retry once after clearing
 *      overlays, with a force-click fallback).
 *   3. Last resort: navigate to `?addSource=true`, which auto-opens.
 */
async function openAddSourceOverlay(page: Page): Promise<void> {
  if (await isOverlayVisible(page)) {
    log.info("  ✅ Add-source dialog already open, reusing");
    return;
  }

  // Clear informational popovers / stale backdrops that intercept clicks.
  await dismissOverlays(page);

  // Try the sidebar button first — fastest path on a populated notebook.
  // Three rounds: normal click, force click, then a direct DOM click (the
  // rebranded UI's invisible backdrop defeats locator hit-testing).
  for (let round = 0; round < 3; round++) {
    try {
      await page
        .locator(joinAlt(Selectors.sources.addButton))
        .first()
        .click({ timeout: 5_000, force: round >= 1 });
      await page
        .locator(Selectors.sources.overlayPane)
        .first()
        .waitFor({ state: "visible", timeout: 8_000 });
      return;
    } catch (err) {
      if (round === 0) {
        log.warning(`  ⚠️  Add-source button click failed (${err}), retrying with force…`);
        await dismissOverlays(page);
      } else if (round === 1) {
        log.warning("  ⚠️  Force click failed, trying direct DOM click…");
        let opened = false;
        for (const sel of Selectors.sources.addButton) {
          if (await domClick(page, sel)) {
            await page
              .locator(Selectors.sources.overlayPane)
              .first()
              .waitFor({ state: "visible", timeout: 8_000 })
              .catch(() => undefined);
            if (await isOverlayVisible(page)) {
              log.info(`  ✅ Add-source dialog opened via DOM click (${sel})`);
              opened = true;
              break;
            }
          }
        }
        if (opened) return;
        // Last DOM fallback used successfully in E2E verification: the text
        // link inside the sources panel.
        if (await domClick(page, ".add-source-link")) {
          await page
            .locator(Selectors.sources.overlayPane)
            .first()
            .waitFor({ state: "visible", timeout: 8_000 })
            .catch(() => undefined);
          if (await isOverlayVisible(page)) {
            log.info("  ✅ Add-source dialog opened via DOM click (.add-source-link)");
            return;
          }
        }
      } else {
        log.warning(
          `  ⚠️  Add-source DOM click failed (${err}), trying ?addSource=true URL fallback`
        );
      }
    }
  }

  // URL fallback — useful when the sidebar button is hidden or covered.
  const url = page.url();
  if (url && /\/notebook\//.test(url) && !url.includes("addSource=true")) {
    const u = new URL(url);
    u.searchParams.set("addSource", "true");
    await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page
      .locator(Selectors.sources.overlayPane)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    return;
  }

  throw new Error('Could not open the "Add source" dialog');
}

async function isOverlayVisible(page: Page): Promise<boolean> {
  return page
    .locator(Selectors.sources.overlayPane)
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

/**
 * Direct DOM click fallback. The rebranded UI keeps an invisible
 * `.cdk-overlay-backdrop` mounted that intercepts Playwright locator clicks;
 * a dispatched click on the element itself bypasses hit testing entirely.
 * Returns true when a matching element was found and clicked.
 */
async function domClick(page: Page, selector: string): Promise<boolean> {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      (el as HTMLElement).click();
      return true;
    }, selector)
    .catch(() => false);
}

async function pickSourceType(page: Page, type: SourceType): Promise<void> {
  const candidates =
    type === "url" ? Selectors.sources.sourceTypeUrl : Selectors.sources.sourceTypeText;
  const overlay = page.locator(Selectors.sources.overlayPane).first();

  // NOTE: do NOT run dismissOverlays here. Once the add-source dialog is
  // open, its own cdk backdrop is detected by dismissOverlays and the
  // Escape press closes the dialog we just opened (verified live 2026-09).
  for (const sel of candidates) {
    const target = overlay.locator(sel).first();
    if (await target.isVisible({ timeout: 1_000 }).catch(() => false)) {
      try {
        await target.click({ timeout: 3_000 });
      } catch {
        // Interception retry: force-click bypasses the hit-target check.
        log.warning(`  ⚠️  Source-type click intercepted, retrying with force…`);
        await dismissOverlays(page);
        await target.click({ timeout: 3_000, force: true });
      }
      // Sub-dialog needs a moment to hydrate before we type.
      await safeSleep(page, 500);
      return;
    }
  }
  // Older overlays drop straight to the input (no type picker) — that's fine.
}

async function fillSourceContent(page: Page, input: AddSourceInput): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();

  // Wait for the overlay to actually contain a textarea (the picker swap is
  // animated, so a tight 500 ms wait beats a busy poll).
  await safeSleep(page, 500);

  const inputCandidates = [
    Selectors.sources.overlayTextarea,
    Selectors.sources.overlayInput,
    `${Selectors.sources.overlayPane} textarea:not(.query-box-input):not(.query-box-textarea)`,
  ];

  let target = null;
  for (const sel of inputCandidates) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 2_000 }).catch(() => false)) {
      target = candidate;
      break;
    }
  }

  if (!target) {
    throw new Error(
      "Could not find an input field inside the Add-source overlay. " +
        "NotebookLM UI may have changed — please file an issue."
    );
  }

  // Title goes in a separate input when one is present; otherwise we prefix
  // it onto the text content (Fork's fallback for older overlays).
  let body = input.content;
  if (input.title && input.type === "text") {
    let titleInputFound = false;
    const titleSelectors = [
      'input[placeholder*="title" i]',
      'input[placeholder*="name" i]',
      'input[name="title"]',
      `${Selectors.sources.overlayPane} input[type="text"]:not([readonly])`,
    ];
    for (const sel of titleSelectors) {
      const candidate = overlay.locator(sel).first();
      if (await candidate.isVisible({ timeout: 500 }).catch(() => false)) {
        await candidate.fill(input.title).catch(() => undefined);
        titleInputFound = true;
        break;
      }
    }
    if (!titleInputFound) {
      body = `${input.title}\n\n${input.content}`;
    }
  }

  await target.fill(body);
  // Small settle delay before clicking submit; Material's primary button
  // briefly stays disabled after `fill()` while validators run.
  await safeSleep(page, 300);
}

async function confirmInsert(page: Page): Promise<void> {
  const overlay = page.locator(Selectors.sources.overlayPane).first();
  for (const sel of Selectors.sources.insertConfirm) {
    const btn = overlay.locator(sel).first();
    if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const disabled = await btn.isDisabled().catch(() => false);
      if (disabled) continue;
      try {
        await btn.click({ timeout: 5_000 });
      } catch {
        // Force-click fallback when a lingering overlay intercepts.
        await dismissOverlays(page);
        await btn.click({ timeout: 5_000, force: true }).catch(async () => {
          // The rebranded UI's backdrop can still defeat force clicks; the
          // dispatched DOM click is the verified last resort (E2E 2026-09).
          const text = sel.match(/has-text\("([^"]+)"\)/)?.[1];
          if (text && (await domClick(page, `.cdk-overlay-pane button:has-text("${text}")`))) {
            log.info(`  ✅ submit clicked via DOM click (${text})`);
            return;
          }
          throw new Error(`Insert click failed for selector: ${sel}`);
        });
      }
      log.info(`  ✅ submit clicked (selector: ${sel})`);
      return;
    }
  }
  // Fallback: pressing Enter in many flows submits the form.
  log.warning("  ⚠️  No insert button matched, pressing Enter as fallback");
  await page.keyboard.press("Enter");
}

/**
 * Wait until the Add-source modal animates away. NotebookLM only appends the
 * new sidebar entry once the modal is fully gone, so we *must* wait here.
 */
async function waitForOverlayToClose(page: Page, timeoutMs: number = 30_000): Promise<void> {
  await page
    .locator(Selectors.sources.overlayPane)
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .catch(() => undefined);
  // The rebranded UI can leave a dark `cdk-overlay-backdrop` behind after the
  // dialog itself is gone — clear it so subsequent chat clicks are not blocked.
  await dismissOverlays(page);
}

async function waitForSourceCountIncrease(
  page: Page,
  before: number,
  timeoutMs: number = 90_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await countSources(page);
    if (current > before) return current;
    await safeSleep(page, 500);
  }
  return await countSources(page);
}

/**
 * Look for an error toast / `[role="alert"]` describing why the upload
 * failed. We filter against Material-icon-name leakage (e.g. `more_vert`),
 * which would otherwise produce nonsense error strings.
 */
async function readDialogError(page: Page): Promise<string | null> {
  const errorSelectors = [
    '[role="alert"]:visible',
    ".error-message:visible",
    ".mdc-snackbar--open",
  ];
  const ICON_LEAKS = ["more_vert", "more_horiz", "open_in_new", "content_copy"];

  for (const sel of errorSelectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const txt = (await el.textContent({ timeout: 1_000 }).catch(() => null))?.trim();
      if (!txt || txt.length > 240) continue;
      if (ICON_LEAKS.some((leak) => txt.includes(leak))) continue;
      return txt;
    } catch {
      continue;
    }
  }
  return null;
}
