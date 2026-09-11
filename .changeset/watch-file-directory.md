---
'contentmap': patch
---

`ctx.addWatchFile('./relative/path')` resolves against the document's own directory. It resolved against the project root instead, so for any collection outside the root it watched a file that did not exist, and editing the real one never rebuilt the document.
