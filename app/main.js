const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

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
      throw new Error(`Object ${objectHash} not found`);
    }
    throw error;
  }
}
