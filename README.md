# dap

a small, local notetaking app. your notes are files.

```bash
node bin/dap.js ~/notes
```

that's it. `~/notes` is a folder. the notes are `.md` files inside it. nothing
leaves your machine, there's no account, and if you delete dap the files are
still there.

## from a terminal

```bash
dap ls                    list every note, newest first
dap find budget           search names and contents
dap cat budget            print raw markdown
dap path budget           print its full path
dap new "an idea"         create a note
```

none of these need the server running — they read the folder directly, so they
work over ssh, in a script, or at 3am from a laptop that never opened a browser.

set `DAP_VAULT` once, or pass `-C <folder>`.

output goes plain and one-per-line when it isn't a terminal, and exit codes
mean something (0 found, 1 nothing found, 2 asked wrong), so it composes:

```bash
dap find budget | xargs grep -l urgent
vim "$(dap path meeting)"
pbpaste | dap new "from clipboard"
dap cat budget | pandoc -o budget.pdf
```

partial names are fine — `dap cat groc` finds `groceries.md`. two matches is a
question rather than a guess: it prints both and stops.

## running the tests

```bash
npm install                     # dependencies
npx playwright install chromium # the browser the tests drive — separate step
npm test
```

`npm install` gets the playwright library but not the browser binary, which is
why the second line exists. Skip it and every test fails in milliseconds.

the tests drive a real browser and they **wait**. every one that types something
then sits still for a second before checking. that pause is the point.

## how it's put together

```
bin/dap.js      cli entry
src/vault.js    a folder of files, with path safety and hash-checked writes
src/server.js   node:http, no framework
web/            the browser app
  editor.js     the editing surface, behind a small interface
  app.js        wiring
  style.css     design tokens, both themes
test/           browser tests
```

**the editor is behind an interface on purpose.** nothing outside `editor.js`
knows what engine renders the text. the app calls methods and subscribes to
changes; it never hands the editor state to hold and never reaches inside. swap
the engine by satisfying the same seven methods.

**writes are hash-checked.** the client sends the hash it last read; if the file
on disk no longer matches, the server refuses and says so rather than
overwriting. that's what makes it safe to keep a note open here and edit it in
another program.

**opening a note never writes to it.** there's a test for that, and it will
matter more once a markdown serializer is in the loop.
