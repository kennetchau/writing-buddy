# agent/Feature_Request.md

> Status: **ITEMS 1–11 IMPLEMENTED + TESTED** (1–8 done 2026-10-08,
> 9–11 done 2026-10-09; 68 tests passing). Items **12–13 code-complete +
> server-side verified 2026-10-11** (Change Request round 3) — tick them
> after the host re-deploy + user browser walkthrough. Items **14–15
> implemented + tested 2026-10-13** (Change Request round 4, 79 tests
> passing).
> **Re-deploy needed on the host before the user sees these.**

--- General ---
1. [x] Currently the app css is only for desktop uses. Make the changes so mobile device would be supported as well. (e.g. when using mobile the nav bar took a lot of the space and the content is squish so make it a bad reading experience)
9. [x] Login screen: remember me button — if clicked, it doesn't log out (30-day persistent session); otherwise it logs out when the browser closes (session cookie).

--- Story ---
2. [x] Story, Chapter. somewhere near the title bar there should be a drop down that allow the user to provide a word count hint to the AI. (E.g. under 1000 words, 1000-3000 words, 3000-6000 words, 6000-9000 words, 9000+ words). This choice will then injected in the system prompt for Generate Chapter. No real wc verificatio is needed, this just act as a type hint.
3. [x] Story, Chapter. There should be a way to preview the final product. (Yes there is a body text box where you can edit but i mean there should be a preview button that when click will open a similar reading panel like whats in the shelf)
4. [x] Story, Chapter. Save chapter should not automatically close the chapter (since we are writing a draft and generate this chapter won't show up until you save)
10. [x] Lore: categorize — user-defined categories (the user can add and delete them) and attach lore entries to them. (Implemented per universe: categories live on the universe's lore page, entries pick them via checkboxes in the entry editor.)

--- Shelf ---
5. [x] For the shelf. the chapters should be collapsable and at the top and end of the chapter should have a forward and backward button so the user can navigate to the previous or next chapter. 

--- AI Monitor ---
6. [x] AI Monitor: Currently there's no way to stop the AI from writing, a red button should be added (like a emergency stop) where when click will cancel the current job. 
7. [x] AI Monitor: IF the model is thinking it should be shown in the active action panel as well. (Review the llama.cpp source code to see how thinking is implemented) — implemented via llama.cpp `reasoning_content` chat deltas; the app streams them as `thought` events. **Host note: only visible if the llama server is run with reasoning extraction (`--reasoning-format deepseek` or equivalent).**
8. [x] AI Monitor: Previous update, added the option to generate this chapter instead of writing next chapter but the system prompt does not allow user to customize generate this chapter. It need to be added
11. [x] AI Control screen and story screen: a new "style prompt" field — think of it as a *skill*: the user defines how they would like the AI to write the story/article, can save MULTIPLE skills (managed on the AI Monitor), and on the story generate-chapter there is a drop down (next to the word-count hint) to pick one (or none). The chosen skill is injected into the system prompt when they click generate (both "next chapter" and "this chapter" modes).

--- Change request (2026-10-11) ---
12. [ ] Story input boxes (outline + chapter body): render the markdown as the user types — one live pane, not a raw text box and not a side-by-side preview. (Decision: CodeMirror 6 markdown editor, bundled via esbuild; `marked` considered then dropped since the editor renders inline. Existing Preview button still shows the exact final Shelf look.)
13. [ ] Story outline: typing `/keyword` does a live database search of my lore as I type (`/star` → finds "Star Destroyer"), and picking a suggestion inserts it as a standard `[Title](Title)` outline link — so Verify shows it matched and Generate pulls that entry's lore, with no new syntax.

--- Change request (2026-10-13) ---
14. [x] Story: the Summarize function has no guidance on when to use it. Add a hint — after ~3-4 chapters without a summary the story page asks "do you want to summarize now?" with a one-click Summarize (FR-23a). Must be **disableable in settings** (done: ⚙ Settings → Hints on the story page — off/on + threshold, per-user, stored in Postgres).
15. [x] Story: a button in the story section where, once multiple chapters exist, the AI reads the last couple of chapters and summarizes the writing style, so the user can **save it** (FR-22e). (Done: "✍ Extract style" next to the Style dropdown — streams the style description. ~~Save-as-style / Discard~~ superseded by FR-17: the result is auto-saved.)

--- Change request (2026-10-14) ---
16. [x] AI/Summarize: the run keeps dying with no summary saved. Boost the summarize token count to 40,000. (Done: `maxTokens` 600 → 40000 in `runSummarize` — the model's "thinking" tokens count against the budget and 600 left no room for the actual answer; the llama server clamps to the remaining context if it is smaller. The exact failure text is also visible now: the story page shows a DB-backed "last AI run failed" banner on the next visit.)

--- Change request (2026-10-15) ---
17. [x] Extract style must SAVE the style — navigating away from the screen used to lose it (saving only happened if the user clicked "Save as style" before leaving). (Done: `runStyleExtract` now auto-saves the result into `style_prompt` as `<story title>'s style` before the `done` event — re-extracting UPDATES the same row instead of duplicating; the story page offers Rename / Delete via the existing style-prompt API. Test: the style-extract case in `tests/phase4.spec.ts` asserts the row + upsert.)
18. [x] AI: thinking models need at least 20k tokens. (Done: `chatStream` default `max_tokens` 8192 → **20000** (`DEFAULT_MAX_TOKENS` in `src/ai/llm.ts`) for ALL actions — only summarize was sending an explicit value (40000, kept); tests assert the 20k floor on generate + style-extract and 40k on summarize. Also: every empty-answer error now carries `EMPTY_ANSWER_HINT` ("likely spent its token budget 'thinking' — increase the llama server's context size (e.g. -c 32768)…") so the failed-run banner says where the fix is. **HOST-SIDE CAVEAT: `max_tokens` is only the output cap — llama.cpp clamps it to the remaining CONTEXT window, so if the llama server runs with a small `-c` a thinking model still runs dry; that setting lives on the llama.cpp server, not in this repo.** Fake-llm can now stream reasoning-only answers; new test asserts the diagnostic error + no style saved.)
19. [x] AI Monitor: the monitor does not actually refresh once a job is complete — hard to tell if a job succeeded. (Root cause: `GET /api/ai/current` returns `run: null` the moment a run finishes, so the 5s poll snapped the "Active action" card back to "idle" AND hid the stream pane — the outcome (done/error) was visible for at most one poll, and a reload showed nothing. Done: `/api/ai/current` now also returns `last` — the user's most recent run of ANY status from the `ai_run` table (id/kind/status/error/started/ended/title). The monitor card flips to **"✓ <action> finished — <time>"** (green) / **"✗ <action> failed — <time>"** (red, hover = error text; pane re-shows the failure reason after a reload) and keeps the streamed output when the run ends while the user is watching. Survives page reloads. **Follow-up (same round):** the Style prompts (skills) section is server-rendered, so a skill auto-saved by a finished extract run didn't appear until a manual refresh — the monitor now refetches `/api/style-prompts` and re-renders that section (same markup + save/delete handlers) the moment a `style_extract` run it was watching finishes successfully. Tests: the `/api/ai/current` badge test asserts `last` after a successful run; the thinking-dry test asserts `last.status = "error"` + the error text.)
