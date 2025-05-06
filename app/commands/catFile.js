const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function catFileCommand(objectHash) {
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
      // Ensure it's a blob object for cat-file -p (though spec doesn't strictly require check)
      // if (!header.startsWith('blob ')) {
      //   throw new Error(`Object ${objectHash} is not a blob object`);
      // }
      const content = decompressedContent.slice(nullByteIndex + 1);
      
      // Print content to stdout
      process.stdout.write(content);
    } else {
      throw new Error("Invalid git object format");
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`fatal: Not a valid object name ${objectHash}`);
      process.exit(1); // Exit with non-zero code for fatal errors
    }
    // Re-throw other errors
    throw error;
  }
}

module.exports = { catFileCommand };
