const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { writeBlobObject } = require("../utils/objectUtils"); // Import the utility

function writeTreeCommand(dirPath = process.cwd()) {
  const entriesData = [];
  const entries = fs.readdirSync(dirPath);

  for (const entryName of entries) {
    // Crucially, skip the .git directory itself!
    if (entryName === '.git') {
      continue; 
    }

    const fullPath = path.join(dirPath, entryName);
    let stats;
    try {
      // Use lstat to handle symbolic links correctly if needed in the future,
      // but for now, stat is sufficient as we skip non-files/dirs.
      stats = fs.statSync(fullPath); 
    } catch (error) {
      // Handle cases where file might disappear between readdir and stat
      console.error(`Error stating file ${fullPath}: ${error}`);
      continue; 
    }


    let mode;
    let hashHex;

    if (stats.isDirectory()) {
      mode = '40000'; // Git mode for directory
      hashHex = writeTreeCommand(fullPath); // Recursive call for subdirectories
    } else if (stats.isFile()) {
      // Determine file mode (executable or not)
      // Note: This check might not be perfectly cross-platform.
      const isExecutable = (stats.mode & fs.constants.S_IXUSR) !== 0;
      mode = isExecutable ? '100755' : '100644'; // Git modes for files
      hashHex = writeBlobObject(fullPath); // Create blob object for files using the utility
    } else {
      // Skip other types like symbolic links, sockets, etc. for now
      // console.warn(`Skipping non-file/directory entry: ${entryName}`);
      continue;
    }

    // Convert hex hash to raw bytes (Buffer)
    const hashBytes = Buffer.from(hashHex, 'hex');

    entriesData.push({
      mode: mode,
      name: entryName,
      hashBytes: hashBytes
    });
  }

  // Sort entries alphabetically by name as required by Git
  entriesData.sort((a, b) => {
    // Git sorts names byte-wise, which localeCompare usually handles correctly for typical filenames.
    // For strictness, especially with unusual characters, byte comparison might be needed:
    // return Buffer.from(a.name).compare(Buffer.from(b.name));
    return a.name.localeCompare(b.name);
  });


  // Construct the tree content
  const treeContentParts = entriesData.map(entry => {
    return Buffer.concat([
      Buffer.from(`${entry.mode} ${entry.name}\0`), // Null-terminate the name
      entry.hashBytes // Append the raw 20-byte hash
    ]);
  });
  const treeContentBuffer = Buffer.concat(treeContentParts);

  // Construct the tree header
  const header = `tree ${treeContentBuffer.length}\0`;
  const treeObjectData = Buffer.concat([Buffer.from(header), treeContentBuffer]);

  // Calculate the SHA-1 hash of the complete tree object
  const treeHash = crypto.createHash('sha1').update(treeObjectData).digest('hex');

  // Write the tree object to the .git/objects directory
  const directory = treeHash.substring(0, 2);
  const filename = treeHash.substring(2);
  const objectDir = path.join(process.cwd(), ".git", "objects", directory);
  const objectPath = path.join(objectDir, filename);

  // Compress the tree object data
  const compressedContent = zlib.deflateSync(treeObjectData);

  // Create object directory if it doesn't exist
  if (!fs.existsSync(objectDir)) {
    fs.mkdirSync(objectDir, { recursive: true });
  }

  // Write the compressed object
  fs.writeFileSync(objectPath, compressedContent);

  return treeHash; // Return the hash of the created tree object
}

module.exports = { writeTreeCommand };
