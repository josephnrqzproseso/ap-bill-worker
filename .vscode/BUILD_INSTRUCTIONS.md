# Build button does nothing? Use this instead

Cursor’s **Build** button in the top bar often doesn’t run the project’s build task. Use one of these:

## Option 1: Terminal (always works)

Open a terminal (Ctrl+` or Terminal → New Terminal). In PowerShell or Command Prompt, type only this (no backticks, no word "bash"):

    npm run build

Or:

    npm run check

## Option 2: Command Palette — use Enter, not click

1. Press **Ctrl+Shift+P**
2. Type **runbu** or **Run Build Task**
3. When “Tasks: Run Build Task” is highlighted, **press Enter** (do not click — clicking often does nothing in Cursor’s palette)
4. If a task list appears, choose **build** and press Enter again

## Option 3: Keyboard shortcut

Press **Ctrl+Shift+B** — runs the default build task. Try this without opening the palette.

---

**If nothing works (button, palette, Ctrl+Shift+B):** Cursor may be not running tasks properly. Use **Option 1** every time: open Terminal (Ctrl+`) and run `npm run build`. That always works.

**Why the orange Build button does nothing:** In Cursor that button is tied to Composer/plan “Build”, not to “Run Build Task”. So it often does nothing. The palette and Ctrl+Shift+B use the real build task; if those don’t respond either, use the terminal.
