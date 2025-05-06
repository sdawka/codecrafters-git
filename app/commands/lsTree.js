const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function lsTreeCommand(treeHash, nameOnly) {
  const directory = treeHash.substring(0, 2);
  const filename = treeHash.substring(2);
  const objectPath = path.join(process.cwd(), ".git", "objects", directory, filename);

  try {
    const compressedContent = fs.readFileSync(objectPath);
    const decompressedContent = zlib.inflateSync(compressedContent);

    const nullByteIndex = decompressedContent.indexOf(0);
    if (nullByteIndex === -1) {
      throw new Error("Invalid tree object format: missing null byte in header");
    }

    const header = decompressedContent.slice(0, nullByteIndex).toString();
    if (!header.startsWith("tree ")) {
      throw new Error(`Invalid object type for hash ${treeHash}. Expected tree.`);
    }

    let entriesContent = decompressedContent.slice(nullByteIndex + 1);
    let currentIndex = 0;

    while (currentIndex < entriesContent.length) {
      // Find the space after the mode
      const spaceIndex = entriesContent.indexOf(32, currentIndex); // 32 is ASCII for space
      if (spaceIndex === -1) {
        throw new Error("Invalid tree entry format: missing space after mode");
      }
      const mode = entriesContent.slice(currentIndex, spaceIndex).toString();

      // Find the null byte after the name
      const nameNullByteIndex = entriesContent.indexOf(0, spaceIndex + 1);
      if (nameNullByteIndex === -1) {
        throw new Error("Invalid tree entry format: missing null byte after name");
      }
      const name = entriesContent.slice(spaceIndex + 1, nameNullByteIndex).toString();

      // Extract the 20-byte SHA-1 hash
      const hashStartIndex = nameNullByteIndex + 1;
      const hashEndIndex = hashStartIndex + 20;
      if (hashEndIndex > entriesContent.length) {
          throw new Error("Invalid tree entry format: insufficient data for hash");
      }
      const hashBytes = entriesContent.slice(hashStartIndex, hashEndIndex);
      const hashHex = hashBytes.toString('hex');

      // Determine type based on mode
      let type;
      if (mode === '40000') {
        type = 'tree';
      } else if (mode === '100644' || mode === '100755' || mode === '120000') { // Added symlink mode
        type = 'blob'; // Treat symlinks as blobs for ls-tree output
      } else {
        type = 'unknown'; // Should not happen in valid trees
      }

      if (nameOnly) {
        console.log(name);
      } else {
        console.log(`${mode} ${type} ${hashHex}\t${name}`);
      }

      // Move to the next entry
      currentIndex = hashEndIndex;
    }

  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`fatal: Not a valid object name ${treeHash}`);
      process.exit(1);
    }
    // Log specific parsing errors for debugging
    console.error(`Error processing tree object ${treeHash}: ${error.message}`);
    process.exit(1);
  }
}


module.exports = { lsTreeCommand };
