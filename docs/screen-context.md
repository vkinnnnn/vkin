# Screen context (PRD v2 Phase 5)

Manual, previewed, one answer, then gone. Never continuous.

## Flow

1. **Ctrl+Alt+S** (or ⋮ → Screenshot…) captures the display under the mouse once. The overlay and
   prep windows are content-protected, so they are not in the picture. The overlay shows a preview;
   nothing has been read or sent yet.
2. Choose how to read it:
   - **Read text (on this PC)**: Windows OCR (`Windows.Media.Ocr` via Windows PowerShell's WinRT
     bridge). Offline; the image goes to a private temp file that is deleted right after (~1 s).
   - **Describe with Gemini**: a downscaled JPEG (≤1280 px wide) goes to the `vision` route
     (`gemini-3.5-flash`, free tier: Google may use what you send). Needs "Gemini fallback" switched
     on in the ⋮ menu. Priced before admission by image tiles (768×768 px = 258 tokens each), ledgered,
     never falls back to another model, reasoning off.
3. **Answer with this** attaches the text as `<screen_context>` (untrusted data, capped at 700 tokens,
   forged tags stripped) to exactly one answer: the question you typed in the panel, else the last
   question they asked. The validator sees it as context. Then the screenshot and text are dropped.
4. **Discard**, panic hide, or 3 minutes unused also drop it. **Save image…** writes a PNG only when
   you ask.

Telemetry records only the route label (`screen: "ocr" | "vision"`), never the text.

## Verified (2026-10-17)

- OCR on a rendered test image: both lines exact, 1.07 s, temp file removed.
- In the app: hotkey → preview of the 1920×1200 display → OCR 919 ms → "Answer with this" sent 2,892
  characters of context into one answer (blocked by the AI-off switch, so $0).
- Gemini vision on a synthetic code screenshot: exact code + error transcription, 2.8 s, $0.

## Files

`src/main/screen/{screen-context,ocr}.js`, engine `screen` build option, `turns.answerWithScreen`,
budget image-token estimate (`budget/guard.js`), registry `vision` route.
