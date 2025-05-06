const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.error("Logs from your program will appear here!");

// Uncomment this block to pass the first stage
const command = process.argv[2];

switch (command) {
  case "init":
    createGitDirectory();
    break;
  case "cat-file":
    if (process.argv[3] === "-p") {
      const objectHash = process.argv[4];
      catFile(objectHash);
    } else {
      throw new Error("cat-file command requires the -p option");
    }
    break;
  case "hash-object":
    let writeObject = false;
    let filePathIndex = 3;
    if (process.argv[3] === "-w") {
      writeObject = true;
      filePathIndex = 4;
    }
    const filePath = process.argv[filePathIndex];
    if (!filePath) {
      throw new Error("hash-object command requires a file path");
    }
    hashObject(filePath, writeObject);
    break;
  case "ls-tree":
    let nameOnly = false;
    let treeHashIndex = 3;
    if (process.argv[3] === "--name-only") {
      nameOnly = true;
      treeHashIndex = 4;
    }
    const treeHash = process.argv[treeHashIndex];
    if (!treeHash) {
      throw new Error("ls-tree command requires a tree hash");
    }
    lsTree(treeHash, nameOnly);
    break;
  default:
    throw new Error(`Unknown command ${command}`);
}

function createGitDirectory() {
  fs.mkdirSync(path.join(process.cwd(), ".git"), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), ".git", "refs"), { recursive: true });

  fs.writeFileSync(path.join(process.cwd(), ".git", "HEAD"), "ref: refs/heads/main\n");
  console.log("Initialized git directory");
}

function catFile(objectHash) {
  // Extract directory and filename from the hash
  const directory = objectHash.substring(0, 2);
  const filename = objectHash.substring(2);
  
  // Construct path to the object file
  const objectPath = path.join(process.cwd(), ".git", "objects", directory, filename);
  
  try {
    // Read the compressed content
    const compressedContent = fs.readFileSync(objectPath);
    
    // Decompress the content
    const decompressedContent = zlib.inflateSync(compressedContent);
    
    // Extract the actual content
    // Format is: "<type> <size>\0<content>"
    const nullByteIndex = decompressedContent.indexOf(0);
    if (nullByteIndex !== -1) {
      const header = decompressedContent.slice(0, nullByteIndex).toString();
      const content = decompressedContent.slice(nullByteIndex + 1);
      
      // Print content to stdout
      process.stdout.write(content);
    } else {
      throw new Error("Invalid git object format");
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`fatal: Not a valid object name ${objectHash}`);
      process.exit(1);
    }
    throw error;
  }
}

function hashObject(filePath, writeObject) {
  try {
    // Read the file content
    const content = fs.readFileSync(filePath);
    
    // Prepare the blob object content
    const header = `blob ${content.length}\0`;
    const store = Buffer.concat([Buffer.from(header), content]);
    
    // Calculate the SHA-1 hash
    const hash = crypto.createHash('sha1').update(store).digest('hex');
    
    // Print the hash
    console.log(hash);
    
    // Write the object if -w flag is present
    if (writeObject) {
      const directory = hash.substring(0, 2);
      const filename = hash.substring(2);
      const objectDir = path.join(process.cwd(), ".git", "objects", directory);
      const objectPath = path.join(objectDir, filename);
      
      // Compress the content
      const compressedContent = zlib.deflateSync(store);
      
      // Create directory if it doesn't exist
      if (!fs.existsSync(objectDir)) {
        fs.mkdirSync(objectDir, { recursive: true });
      }
      
      // Write the compressed content to the object file
      fs.writeFileSync(objectPath, compressedContent);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}

function lsTree(treeHash, nameOnly) {
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
      } else if (mode === '100644' || mode === '100755' || mode === '120000') {
        type = 'blob';
      } else {
        type = 'unknown';
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
    console.error(`Error processing tree object ${treeHash}: ${error.message}`);
    process.exit(1);
  }
}
