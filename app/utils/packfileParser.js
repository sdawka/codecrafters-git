const zlib = require("zlib");
const crypto = require("crypto");
const { writeGitObject, readObject } = require("./objectUtils");

/**
 * Apply a delta to a base object's content
 * @param {Buffer} baseContent - The content of the base object
 * @param {Buffer} deltaData - The delta data
 * @returns {Buffer} - The reconstructed content
 */
function applyDelta(baseContent, deltaData) {
  let deltaOffset = 0;

  // Read source size
  let byte = deltaData[deltaOffset++];
  let sourceSize = byte & 0x7f;
  let shift = 7;
  while (byte & 0x80) {
    if (deltaOffset >= deltaData.length) throw new Error("Delta error: EOF reading source size");
    byte = deltaData[deltaOffset++];
    sourceSize |= (byte & 0x7f) << shift;
    shift += 7;
  }
  if (sourceSize !== baseContent.length) {
    throw new Error(`Delta error: Expected source size ${sourceSize}, but base object size is ${baseContent.length}`);
  }

  // Read target size
  if (deltaOffset >= deltaData.length) throw new Error("Delta error: EOF reading target size");
  byte = deltaData[deltaOffset++];
  let targetSize = byte & 0x7f;
  shift = 7;
  while (byte & 0x80) {
    if (deltaOffset >= deltaData.length) throw new Error("Delta error: EOF reading target size");
    byte = deltaData[deltaOffset++];
    targetSize |= (byte & 0x7f) << shift;
    shift += 7;
  }

  const reconstructedContent = Buffer.alloc(targetSize);
  let reconstructedOffset = 0;

  // Apply delta operations
  while (deltaOffset < deltaData.length) {
    const instruction = deltaData[deltaOffset++];
    
    // Copy instruction
    if (instruction & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let currentShift = 0;
      
      for (let i = 0; i < 4; i++) {
        if (instruction & (1 << i)) {
          if (deltaOffset >= deltaData.length) throw new Error("Delta error: EOF reading copy offset");
          copyOffset |= deltaData[deltaOffset++] << currentShift;
        }
        currentShift += 8;
      }
      
      currentShift = 0;
      for (let i = 0; i < 3; i++) {
        if (instruction & (1 << (i + 4))) {
          if (deltaOffset >= deltaData.length) throw new Error("Delta error: EOF reading copy size");
          copySize |= deltaData[deltaOffset++] << currentShift;
        }
        currentShift += 8;
      }
      
      if (copySize === 0) copySize = 0x10000;

      if (copyOffset + copySize > baseContent.length) {
        throw new Error(`Delta error: Copy instruction reads beyond base object bounds`);
      }
      if (reconstructedOffset + copySize > reconstructedContent.length) {
        throw new Error(`Delta error: Copy instruction writes beyond target buffer bounds`);
      }

      baseContent.copy(reconstructedContent, reconstructedOffset, copyOffset, copyOffset + copySize);
      reconstructedOffset += copySize;
    } 
    // Insert instruction
    else {
      const addSize = instruction & 0x7f;
      if (addSize === 0) {
        throw new Error("Delta error: Add instruction with size 0");
      }
      if (deltaOffset + addSize > deltaData.length) {
        throw new Error(`Delta error: Add instruction reads beyond delta data bounds`);
      }
      if (reconstructedOffset + addSize > reconstructedContent.length) {
        throw new Error(`Delta error: Add instruction writes beyond target buffer bounds`);
      }

      deltaData.copy(reconstructedContent, reconstructedOffset, deltaOffset, deltaOffset + addSize);
      deltaOffset += addSize;
      reconstructedOffset += addSize;
    }
  }

  if (reconstructedOffset !== targetSize) {
    throw new Error(`Delta error: Reconstructed size ${reconstructedOffset} does not match expected target size ${targetSize}`);
  }

  return reconstructedContent;
}

/**
 * Process a packfile and extract/store all objects
 * @param {Buffer} packData - The raw packfile data
 * @returns {Promise<Object>} - Map of extracted object SHA-1s to their types
 */
async function processPackfile(packData) {
  if (packData.length < 12 + 20) {
    throw new Error(`Invalid packfile: Too short (${packData.length} bytes) for header and checksum`);
  }
  
  // Validate packfile header
  const signature = packData.slice(0, 4).toString();
  if (signature !== 'PACK') {
    console.warn(`Warning: Packfile signature is "${signature}", not "PACK". Proceeding anyway.`);
  }
  
  const version = packData.readUInt32BE(4);
  if (version !== 2) {
    console.warn(`Packfile version is ${version} (expected 2). Parsing might be incorrect.`);
  }
  
  const numObjects = packData.readUInt32BE(8);
  console.error(`Packfile header indicates ${numObjects} objects.`);

  let offset = 12;
  let objectsProcessed = 0;
  const writtenObjects = {};
  const objectInfoByOffset = {};

  console.log("Packfile parsing: Processing non-delta and REF_DELTA objects. OFS_DELTA objects are currently skipped.");

  while (objectsProcessed < numObjects && offset < packData.length - 20) {
    const initialOffset = offset;
    let headerInfo = null;
    
    try {
      // Extract object header information
      headerInfo = extractObjectHeader(packData, offset);
      offset += headerInfo.headerSize;
      
      // Skip OFS_DELTA objects for now
      if (headerInfo.type === 'OFS_DELTA') {
        console.warn(`Skipping OFS_DELTA object at offset ${initialOffset}. Implementation pending.`);
        offset = initialOffset + headerInfo.headerSize + headerInfo.compressedDataSize;
        objectsProcessed++;
        continue;
      }
      
      // Extract and decompress the object data
      const decompressedData = await decompressObjectData(packData, offset, packData.length - 20);
      offset += decompressedData.bytesRead;
      
      // Process regular objects
      if (!headerInfo.isDelta) {
        const finalType = headerInfo.type;
        const objectContent = decompressedData.data;
        
        // Validate the decompressed size
        if (objectContent.length !== headerInfo.size && headerInfo.size > 0) {
          console.error(`Size mismatch for ${finalType} at ${initialOffset}. Expected: ${headerInfo.size}, Got: ${objectContent.length}`);
          objectsProcessed++;
          continue;
        }
        
        // Write the object
        const sha = writeGitObject(finalType, objectContent);
        writtenObjects[sha] = finalType;
        objectInfoByOffset[initialOffset] = { 
          sha, 
          type: finalType, 
          size: objectContent.length, 
          headerSize: headerInfo.headerSize, 
          compressedSize: decompressedData.bytesRead 
        };
      }
      // Process REF_DELTA objects
      else if (headerInfo.type === 'REF_DELTA') {
        try {
          const baseObject = await readObject(headerInfo.baseSha);
          if (!baseObject) {
            throw new Error(`Base object ${headerInfo.baseSha} not found. Cannot reconstruct delta.`);
          }
          
          const finalType = baseObject.type;
          const objectContent = applyDelta(baseObject.content, decompressedData.data);
          
          const sha = writeGitObject(finalType, objectContent);
          writtenObjects[sha] = finalType;
          objectInfoByOffset[initialOffset] = { 
            sha, 
            type: finalType, 
            size: objectContent.length, 
            headerSize: headerInfo.headerSize, 
            compressedSize: decompressedData.bytesRead 
          };
        } catch (deltaError) {
          console.error(`Failed to reconstruct REF_DELTA at ${initialOffset}: ${deltaError.message}`);
        }
      }
    } catch (err) {
      console.error(`Error processing object at offset ${initialOffset}: ${err.message}`);
      if (headerInfo) {
        offset = initialOffset + headerInfo.headerSize + (headerInfo.compressedDataSize || 0);
      } else {
        // If we couldn't parse the header, skip ahead and try to recover
        offset += 1;
      }
    }
    
    objectsProcessed++;
  }

  // Verify packfile checksum
  const calculatedChecksum = crypto.createHash('sha1').update(packData.slice(0, packData.length - 20)).digest('hex');
  const expectedChecksum = packData.slice(packData.length - 20).toString('hex');
  
  if (calculatedChecksum !== expectedChecksum) {
    console.warn(`Packfile checksum mismatch! Expected: ${expectedChecksum}, Calculated: ${calculatedChecksum}`);
  } else {
    console.log("Packfile checksum verified.");
  }

  return writtenObjects;
}

/**
 * Extract the header information from a packfile object
 * @param {Buffer} packData - The packfile data
 * @param {number} offset - The offset in the packfile
 * @returns {Object} - Header information
 */
function extractObjectHeader(packData, offset) {
  const initialOffset = offset;
  let isDelta = false;
  let objectType = null;
  let size = 0;
  let headerSize = 0;
  let baseSha = null;
  let baseObjectNegOffset = 0;
  let compressedDataSize = 0;

  // Read the type and size bytes
  let byte = packData[offset++];
  const type = (byte >> 4) & 0x7;
  size = byte & 0xf;
  let shift = 4;
  
  while (byte & 0x80) {
    if (offset >= packData.length - 20) throw new Error("EOF reading object header");
    byte = packData[offset++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  
  headerSize = offset - initialOffset;

  // Determine object type
  switch (type) {
    case 1: 
      objectType = 'commit'; 
      break;
    case 2: 
      objectType = 'tree'; 
      break;
    case 3: 
      objectType = 'blob'; 
      break;
    case 4: 
      objectType = 'tag'; 
      break;
    case 6:
      isDelta = true;
      objectType = 'OFS_DELTA';
      // Extract base object negative offset
      let negOffsetByte = packData[offset++];
      baseObjectNegOffset = negOffsetByte & 0x7f;
      while (negOffsetByte & 0x80) {
        if (offset >= packData.length - 20) throw new Error("EOF reading OFS_DELTA offset");
        negOffsetByte = packData[offset++];
        baseObjectNegOffset = ((baseObjectNegOffset + 1) << 7) | (negOffsetByte & 0x7f);
      }
      headerSize = offset - initialOffset;
      break;
    case 7:
      isDelta = true;
      objectType = 'REF_DELTA';
      // Extract base object SHA
      if (offset + 20 > packData.length - 20) throw new Error("EOF reading REF_DELTA base SHA");
      baseSha = packData.slice(offset, offset + 20).toString('hex');
      offset += 20;
      headerSize = offset - initialOffset;
      break;
    default:
      throw new Error(`Unknown object type ${type}`);
  }

  return {
    type: objectType,
    size,
    isDelta,
    headerSize,
    baseSha,
    baseObjectNegOffset,
    compressedDataSize
  };
}

/**
 * Decompress the object data from a packfile
 * @param {Buffer} packData - The packfile data
 * @param {number} offset - The offset in the packfile
 * @param {number} maxOffset - The maximum offset to read to
 * @returns {Promise<{data: Buffer, bytesRead: number}>} - The decompressed data and bytes read
 */
async function decompressObjectData(packData, offset, maxOffset) {
  return new Promise((resolve, reject) => {
    try {
      const remainingData = packData.slice(offset, maxOffset);
      
      const inflate = zlib.createInflate();
      let decompressed = Buffer.alloc(0);
      
      inflate.on('data', (chunk) => {
        decompressed = Buffer.concat([decompressed, chunk]);
      });
      
      inflate.on('end', () => {
        resolve({
          data: decompressed,
          bytesRead: inflate.bytesRead || 0
        });
      });
      
      inflate.on('error', (err) => {
        reject(new Error(`Decompression error: ${err.message}`));
      });
      
      inflate.write(remainingData);
      inflate.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  processPackfile,
  applyDelta
};