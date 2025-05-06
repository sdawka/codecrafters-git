const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { writeBlobObject } = require("../utils/objectUtils"); // Import the utility

function hashObjectCommand(filePath, writeObject) {
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
      // Use the utility function to write the blob
      writeBlobObject(filePath); 
      // Note: writeBlobObject calculates the hash again internally. 
      // This could be optimized by passing the pre-calculated hash and content,
      // but for simplicity, we'll keep it this way for now.
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`fatal: Cannot open '${filePath}': No such file or directory`);
    }
    throw error;
  }
}

module.exports = { hashObjectCommand };
