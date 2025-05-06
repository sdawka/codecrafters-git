const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

/**
 * Writes a Git object (blob, tree, commit) to the object store.
 * @param {string} type - The type of the object ('blob', 'tree', 'commit').
 * @param {Buffer} content - The raw content of the object.
 * @returns {string} The SHA-1 hash of the created object.
 */
function writeGitObject(type, content) {
  const header = `${type} ${content.length}\0`;
  const store = Buffer.concat([Buffer.from(header, "utf-8"), content]);
  const hash = crypto.createHash('sha1').update(store).digest('hex');

  const directory = hash.substring(0, 2);
  const filename = hash.substring(2);
  const objectDir = path.join(process.cwd(), ".git", "objects", directory);
  const objectPath = path.join(objectDir, filename);

  // Avoid rewriting if object already exists
  if (!fs.existsSync(objectPath)) {
    const compressedContent = zlib.deflateSync(store);

    if (!fs.existsSync(objectDir)) {
      fs.mkdirSync(objectDir, { recursive: true });
    }

    fs.writeFileSync(objectPath, compressedContent);
  }
  return hash;
}

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

async function readObject(sha) {
  const objectPath = path.join(
    process.cwd(),
    ".git",
    "objects",
    sha.substring(0, 2),
    sha.substring(2)
  );

  if (!fs.existsSync(objectPath)) {
    // This can happen if an object is part of a packfile but not yet written individually
    // Or if the SHA is simply incorrect.
    console.warn(`Object ${sha} not found at ${objectPath}`);
    return null;
  }

  try {
    const compressedContent = fs.readFileSync(objectPath);
    const decompressedContent = zlib.inflateSync(compressedContent);

    const nullByteIndex = decompressedContent.indexOf(0);
    if (nullByteIndex === -1) {
      throw new Error(`Invalid object format for ${sha}: no null byte separator`);
    }

    const header = decompressedContent.slice(0, nullByteIndex).toString();
    const content = decompressedContent.slice(nullByteIndex + 1);

    const [type, sizeStr] = header.split(" ");
    const size = parseInt(sizeStr, 10);

    if (isNaN(size) || size !== content.length) {
      throw new Error(
        `Invalid object format for ${sha}: size mismatch (header: ${size}, actual: ${content.length})`
      );
    }

    return { type, content };
  } catch (error) {
    console.error(`Failed to read or parse object ${sha}: ${error.message}`);
    throw error; // Re-throw the error to be handled by the caller
  }
}

module.exports = { writeBlobObject, writeGitObject, readObject };
