// Generate assets/social-preview.png from the site's embed view.
//
// The image is a 1280 x 640 (at 2x) screenshot of the map fitted to the
// register points, suitable for the GitHub repository social preview and
// the og:image tag. Regenerate it when the look of the map changes.
//
// Requires a local Chrome and puppeteer-core:
//   npm install --no-save puppeteer-core
//   python3 -m http.server 8741 &
//   node scripts/social_preview.cjs

const puppeteer = require("puppeteer-core");

const URL = process.env.PREVIEW_URL || "http://localhost:8741/?embed";
const OUT = "assets/social-preview.png";

(async () => {
  const browser = await puppeteer.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: "dark" },
    ]);
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
    // Allow basemap tiles to finish rendering.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await page.screenshot({ path: OUT });
    console.log(`Wrote ${OUT}`);
  } finally {
    await browser.close();
  }
})();
