#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

const outputDir = createControlUiE2eArtifactDir(
  "composer-cap-proof",
  ".artifacts/control-ui-e2e/composer-cap-proof",
);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const bundledChromium = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const executablePath = canRunPlaywrightChromium(bundledChromium)
  ? bundledChromium
  : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const server = await startControlUiE2eServer(
  {
    version: "proof",
    commit,
    commitAt: null,
    builtAt: new Date().toISOString(),
    branch: "fix/chat-composer-autosize-measurement-cap",
    dirty: false,
    release: false,
    buildId: commit,
  },
  { source: true },
);
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({
  colorScheme: "dark",
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);

try {
  const historyMessages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: "text",
        text: `Transcript line ${index + 1}. The reader is following the end of this conversation.`,
      },
    ],
    timestamp: index + 1,
  }));
  await installMockGateway(page, { historyMessages });
  await page.goto(`${server.baseUrl}chat`);
  const textarea = page.locator(".agent-chat__composer-combobox textarea").first();
  await textarea.waitFor({ state: "visible" });
  const thread = page.locator(".chat-thread").first();
  await thread.waitFor({ state: "visible" });
  await page.locator(".chat-bubble").first().waitFor({ state: "visible" });

  const readState = () =>
    page.evaluate(() => {
      const box = document.querySelector<HTMLTextAreaElement>(
        ".agent-chat__composer-combobox textarea",
      );
      const transcript = document.querySelector<HTMLElement>(".chat-thread");
      if (!box || !transcript) {
        return null;
      }
      const maxScroll = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
      return {
        height: box.style.height,
        overflow: box.style.overflowY,
        fadeTop: box.hasAttribute("data-scroll-fade-top"),
        fadeBottom: box.hasAttribute("data-scroll-fade-bottom"),
        chars: box.value.length,
        threadTop: transcript.scrollTop,
        threadMax: maxScroll,
        anchored: maxScroll - transcript.scrollTop <= 8,
      };
    });

  await thread.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await textarea.fill("Short draft.");
  const beforeAnchor = await readState();
  await page.screenshot({ path: path.join(outputDir, "before-anchor.png") });

  const overCap = "Readable line ".repeat(2200);
  await textarea.evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: null }),
    );
  }, overCap);
  await page.waitForTimeout(250);
  const afterAnchor = await readState();
  await page.screenshot({ path: path.join(outputDir, "after-anchor.png") });

  const fadedDraft = `${"Browsed draft line that should fade at the edges.\n".repeat(30)}`;
  await textarea.fill(fadedDraft);
  await textarea.evaluate((el) => {
    el.blur();
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const beforeFade = await readState();
  await page.screenshot({ path: path.join(outputDir, "before-fade.png") });

  await textarea.evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: null }),
    );
  }, overCap);
  await page.waitForTimeout(250);
  const afterFade = await readState();
  await page.screenshot({ path: path.join(outputDir, "after-fade.png") });

  const report = {
    commit,
    baseUrl: server.baseUrl,
    beforeAnchor,
    afterAnchor,
    beforeFade,
    afterFade,
  };
  writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  mkdirSync(outputDir, { recursive: true });
  console.log(JSON.stringify(report, null, 2));
  console.log(`artifacts ${outputDir}`);
} finally {
  await browser.close();
  await server.close();
}
