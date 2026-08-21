# dap

a small, local notetaking app. your notes are files.

```bash
node bin/dap.js ~/notes
```

that's it. `~/notes` is a folder. the notes are `.md` files inside it. nothing
leaves your machine, there's no account, and if you delete dap the files are
still there.

## running the tests

```bash
npm install   # playwright, for the browser tests
npm test
```

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
