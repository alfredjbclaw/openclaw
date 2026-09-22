# Composer measurement-cap proof

Served Control UI, source server, commit `4c31b77b3081848327870831178fea626f2cd15c`.
Not the production gateway. Fixture transcript only. No tokens, endpoints, or user data.

Focused test `ui/src/pages/chat/components/chat-composer-dom.test.ts`: 8 passed.
Vitest shard 1.73s. Wall time 2.00s.

| Shot                | What it shows                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `before-anchor.png` | Short draft, height 36px. Transcript anchored at the end (3392/3392).                                                               |
| `after-anchor.png`  | 30,800-character paste pins the composer at 156px. Transcript stays anchored (3492/3492) after the composer grows. Text is unfaded. |
| `before-fade.png`   | A browsed below-cap draft carries `data-scroll-fade-top`. Transcript still anchored.                                                |
| `after-fade.png`    | Replacing that draft past the cap clears both fade attributes without leaving the end.                                              |

Capture: `node --import ./scripts/tsx.mjs scripts/capture-composer-cap-proof.mts`
