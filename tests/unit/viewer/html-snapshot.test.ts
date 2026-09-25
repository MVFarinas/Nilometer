/**
 * @file The HTML report's whole page, pinned (step G1.7, D-070).
 *
 * D-070 requires a snapshot so any change to the page shows up in review, not only a change that
 * trips a guard. The page is built end to end from the shared scenario (html-fixture.ts) through
 * the real loader, charts, and page, as `report --save --html` builds it. A reviewed change is
 * accepted with `vitest -u`; an unreviewed one fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadHtmlData } from "../../../viewer/html-data.js";
import { renderHtmlReport } from "../../../viewer/html.js";
import { IS_WINDOWS } from "../../setup/platform.js";
import { HTML_FIXTURE_META, buildHtmlFixture } from "./html-fixture.js";

/** The zone the process ran in before this file set its own, restored afterwards. */
let originalTz: string | undefined;

// Months are grouped with SQLite 'localtime', the process zone, so the page is only stable with
// the zone fixed. SQLite on Windows ignores TZ set at runtime (D-049), so the page is pinned
// where the zone can be set.
describe.skipIf(IS_WINDOWS)("the HTML report page", () => {
  beforeAll(() => {
    originalTz = process.env["TZ"];
    process.env["TZ"] = "UTC";
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = originalTz;
    }
  });

  it("matches the reviewed snapshot for the shared scenario", () => {
    const page = renderHtmlReport(loadHtmlData(buildHtmlFixture(), HTML_FIXTURE_META));
    expect(page).toMatchSnapshot();
  });
});
