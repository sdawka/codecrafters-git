const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

function writeBlobObject(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const header = `blob ${content.length}\0`;
    const store = Buffer.concat([Buffer.from(header), content]);
    const hash = crypto.createHash('sha1').update(store).digest('hex');

    const directory = hash.substring(0, 2);
    const filename = hash.substring(2);
    const objectDir = path.join(process.cwd(), ".git", "objects", directory);
    const objectPath = path.join(objectDir, filename);

    const compressedContent = zlib.deflateSync(store);

    if (!fs.existsSync(objectDir)) {
      fs.mkdirSync(objectDir, { recursive: true });
    }

    fs.writeFileSync(objectPath, compressedContent);
    return hash; // Return the hash
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }
}

module.exports = { writeBlobObject };
