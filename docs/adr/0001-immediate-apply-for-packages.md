# Package changes apply immediately, undo replaces Apply/Discard

The UberASM, Custom Blocks and Custom Sprites views used to stage edits in memory until "Apply", while uploads, the package list and Music wrote to the ROM right away. That forced "unsaved changes?" prompts before every upload and gave the dialog two different save models. We decided that every change in the Packages dialog writes to the ROM immediately and is reverted with the editor's ROM undo (which also covers the editor data holding package sources), like every other edit in the editor.

## Consequences

Each single assignment change (e.g. assigning an UberASM file to a level, a sprite to a list.txt slot) rebuilds the whole tool project. This is slower than batching edits behind one "Apply", and we accept it in exchange for one consistent save model.
