const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { initCommand } = require("./init");
const { writeGitObject, readObject } = require("../utils/objectUtils");

// Helper function to parse pkt-line format
function parsePktLine(buffer) {
  const refs = {};
  let offset = 0;
  let firstLine = true; // To handle the capabilities line

  while (offset < buffer.length) {
    const lengthHex = buffer.slice(offset, offset + 4).toString();
    if (lengthHex === '0000') { // Flush packet
      offset += 4;
      continue; // Or break, depending on context
    }

    const length = parseInt(lengthHex, 16);
    if (length === 0) { // Should not happen with non-flush packets
      offset += 4;
      continue;
    }

    if (offset + length > buffer.length) {
      throw new Error(`Invalid pkt-line length: ${lengthHex} at offset ${offset}`);
    }

    const data = buffer.slice(offset + 4, offset + length);
    offset += length;

    const lineStr = data.toString('utf-8').trim();

    if (firstLine) {
      const nullIndex = lineStr.indexOf('\0');
      const firstPart = nullIndex !== -1 ? lineStr.substring(0, nullIndex) : lineStr;
      const spaceIndex = firstPart.indexOf(" ");
      if (spaceIndex !== -1) {
        const sha = firstPart.substring(0, spaceIndex);
        const name = firstPart.substring(spaceIndex + 1);
        if (/^[0-9a-f]{40}$/.test(sha)) {
          refs[name] = sha;
          const capabilities = nullIndex !== -1 ? lineStr.substring(nullIndex + 1) : '';
          const symrefMatch = capabilities.match(/symref=([^:]+):([^\s]+)/);
          if (symrefMatch) {
            refs[symrefMatch[1]] = `ref: ${symrefMatch[2]}`;
          }
        } else {
          console.warn("Could not parse first line as ref:", lineStr);
        }
      }
      firstLine = false;
    } else {
      const spaceIndex = lineStr.indexOf(" ");
      if (spaceIndex !== -1) {
        const sha = lineStr.substring(0, spaceIndex);
        const name = lineStr.substring(spaceIndex + 1);
        if (/^[0-9a-f]{40}$/.test(sha)) {
          refs[name] = sha;
        } else {
          console.warn("Could not parse line as ref:", lineStr);
        }
      } else if (lineStr.startsWith("ERR ")) {
         throw new Error(`Server error: ${lineStr}`);
      }
    }
  }
  return refs;
}

// Function to discover remote references
async function discoverRefs(repoUrl) {
  const parsedUrl = new URL(repoUrl);
  const infoRefsUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}/info/refs?service=git-upload-pack`;
  console.error(`Discovering refs from ${infoRefsUrl}`);

  return new Promise((resolve, reject) => {
    const req = https.get(infoRefsUrl, {
      headers: {
        'User-Agent': 'git/codecrafters-git-js'
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to discover refs: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          let startOffset = 0;
          const firstLengthHex = buffer.slice(0, 4).toString();
          const firstLength = parseInt(firstLengthHex, 16);
          if (firstLength > 0 && buffer.slice(4, firstLength).toString().startsWith('# service=')) {
            startOffset = firstLength;
          }
          const refs = parsePktLine(buffer.slice(startOffset));
          resolve(refs);
        } catch (err) {
          reject(new Error(`Failed to parse refs response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Error during ref discovery request: ${err.message}`));
    });

    req.end();
  });
}

// Function to request the packfile
async function requestPackfile(repoUrl, wantShas) {
  if (!wantShas || wantShas.length === 0) {
    throw new Error("No SHAs provided to request packfile.");
  }
  const parsedUrl = new URL(repoUrl);
  const uploadPackUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}/git-upload-pack`;
  console.error(`Requesting packfile from ${uploadPackUrl}`);

  let body = '';
  // First want line includes capabilities
  const firstWant = `want ${wantShas[0]} multi_ack_detailed side-band-64k thin-pack ofs-delta agent=git/codecrafters-git-js`;
  body += `${(firstWant.length + 4).toString(16).padStart(4, '0')}${firstWant}`;
  
  // Additional want lines
  for (let i = 1; i < wantShas.length; i++) {
    const wantLine = `want ${wantShas[i]}`;
    body += `${(wantLine.length + 4).toString(16).padStart(4, '0')}${wantLine}`;
  }
  
  // Add flush packet between wants and done
  body += '0000';
  
  // Add done line (no newline)
  const doneLine = 'done';
  body += `${(doneLine.length + 4).toString(16).padStart(4, '0')}${doneLine}`;
  
  // Add final flush packet
  body += '0000';

  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-git-upload-pack-request',
        'Accept': 'application/x-git-upload-pack-result',
        'User-Agent': 'git/codecrafters-git-js'
      }
    };

    const req = https.request(uploadPackUrl, options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to request packfile: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const packHeaderIndex = buffer.indexOf('PACK');
        if (packHeaderIndex === -1) {
          let errorMessage = "Packfile signature 'PACK' not found in response.";
          let offset = 0;
          while (offset < buffer.length) {
              const lengthHex = buffer.slice(offset, offset + 4).toString();
              if (lengthHex === '0000') break;
              const length = parseInt(lengthHex, 16);
              if (length < 5) {
                  offset += length;
                  continue;
              }
              const indicator = buffer[offset + 4];
              if (indicator === 2 || indicator === 3) {
                  const message = buffer.slice(offset + 5, offset + length).toString('utf-8');
                  console.error(`Server message (sideband ${indicator}): ${message.trim()}`);
                  if (indicator === 3) {
                      errorMessage += ` Server error: ${message.trim()}`;
                  }
              }
              offset += length;
          }

          return reject(new Error(errorMessage + ` Response buffer (first 100 bytes): ${buffer.slice(0, 100).toString()}`));
        }

        let packData = Buffer.alloc(0);
        let currentOffset = 0;
        while (currentOffset < buffer.length) {
            const lengthHex = buffer.slice(currentOffset, currentOffset + 4).toString();
            if (lengthHex === '0000') {
                currentOffset += 4;
                if (buffer.slice(currentOffset).indexOf('PACK') === 0) {
                    packData = Buffer.concat([packData, buffer.slice(currentOffset)]);
                    break;
                }
                continue;
            }

            const length = parseInt(lengthHex, 16);
            if (length === 0 || currentOffset + length > buffer.length) {
                 console.warn(`Invalid sideband length ${lengthHex} at offset ${currentOffset}. Stopping pack data extraction.`);
                 break;
            }

            const indicator = buffer[currentOffset + 4];
            const dataSlice = buffer.slice(currentOffset + 5, currentOffset + length);

            if (indicator === 1) {
                const packIndexInData = dataSlice.indexOf('PACK');
                if (packIndexInData !== -1) {
                    packData = Buffer.concat([packData, dataSlice.slice(packIndexInData)]);
                } else if (packData.length > 0) {
                    packData = Buffer.concat([packData, dataSlice]);
                }
            } else if (indicator === 2) {
                console.error(`Progress: ${dataSlice.toString('utf-8').trim()}`);
            } else if (indicator === 3) {
                const errorMsg = dataSlice.toString('utf-8').trim();
                console.error(`Error from server: ${errorMsg}`);
            } else {
                 if (buffer.slice(currentOffset).indexOf('PACK') === 0) {
                    packData = Buffer.concat([packData, buffer.slice(currentOffset)]);
                    break;
                 } else {
                    console.warn(`Unexpected data or unknown sideband indicator ${indicator} at offset ${currentOffset}. Length ${length}.`);
                 }
            }
            currentOffset += length;
        }

        if (packData.length === 0 || packData.indexOf('PACK') !== 0) {
             return reject(new Error("Could not extract valid PACK data from sideband response."));
        }

        console.error(`Extracted pack data starting with 'PACK', total size: ${packData.length}`);
        resolve(packData);
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Error during packfile request: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

// Helper function to apply delta instructions
function applyDelta(baseContent, deltaData) {
  let deltaOffset = 0;

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

  while (deltaOffset < deltaData.length) {
    const instruction = deltaData[deltaOffset++];
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
        throw new Error(`Delta error: Copy instruction reads beyond base object bounds (offset ${copyOffset}, size ${copySize}, base size ${baseContent.length})`);
      }
      if (reconstructedOffset + copySize > reconstructedContent.length) {
        throw new Error(`Delta error: Copy instruction writes beyond target buffer bounds (offset ${reconstructedOffset}, size ${copySize}, target size ${reconstructedContent.length})`);
      }

      baseContent.copy(reconstructedContent, reconstructedOffset, copyOffset, copyOffset + copySize);
      reconstructedOffset += copySize;
    } else {
      const addSize = instruction & 0x7f;
      if (addSize === 0) {
        throw new Error("Delta error: Add instruction with size 0");
      }
      if (deltaOffset + addSize > deltaData.length) {
        throw new Error(`Delta error: Add instruction reads beyond delta data bounds (offset ${deltaOffset}, size ${addSize}, delta size ${deltaData.length})`);
      }
      if (reconstructedOffset + addSize > reconstructedContent.length) {
        throw new Error(`Delta error: Add instruction writes beyond target buffer bounds (offset ${reconstructedOffset}, size ${addSize}, target size ${reconstructedContent.length})`);
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

async function cloneCommand(repoUrl, targetDir) {
  console.error(`Cloning from ${repoUrl}`);

  const parsedUrl = new URL(repoUrl);
  if (!targetDir) {
    targetDir = path.basename(parsedUrl.pathname).replace(/\.git$/, "");
  }

  if (fs.existsSync(targetDir)) {
    throw new Error(`Target directory "${targetDir}" already exists.`);
  }

  const refs = await discoverRefs(repoUrl);
  console.error("Discovered refs:", Object.keys(refs));

  const headRefTarget = refs["HEAD"];
  if (!headRefTarget || !headRefTarget.startsWith("ref: ")) {
    if (refs["HEAD"] && /^[0-9a-f]{40}$/.test(refs["HEAD"])) {
      console.warn("HEAD is detached, cloning specific commit.");
    } else {
      throw new Error("Could not determine default branch or HEAD commit from ref discovery.");
    }
  }
  const defaultBranchRef = headRefTarget ? headRefTarget.substring(5).trim() : null;
  const headSha = defaultBranchRef ? refs[defaultBranchRef] : refs["HEAD"];

  if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) {
    const branchInfo = defaultBranchRef ? `default branch "${defaultBranchRef}"` : "HEAD commit";
    throw new Error(`Could not find a valid SHA for ${branchInfo}. Refs found: ${JSON.stringify(refs)}`);
  }
  console.error(`Target commit (HEAD): ${headSha}${defaultBranchRef ? ' on branch ' + defaultBranchRef : ''}`);

  const originalCwd = process.cwd();
  fs.mkdirSync(targetDir);
  process.chdir(targetDir);
  try {
    initCommand();

    console.error(`Requesting packfile for target: ${headSha}...`);
    const packfileData = await requestPackfile(repoUrl, [headSha]);
    console.error(`Received packfile data (size: ${packfileData.length})`);

    console.error("Processing packfile (handling non-delta and REF_DELTA)...");
    const objectsInfo = await processPackfile(packfileData);
    console.error(`Stored ${Object.keys(objectsInfo).length} objects (including reconstructed deltas) from packfile.`);
    if (Object.keys(objectsInfo).length === 0 && packfileData.length > 20) {
      console.warn("No objects were extracted. Checkout will likely fail.");
    }

    const gitDir = path.join(process.cwd(), ".git");

    if (defaultBranchRef) {
      const refPath = path.join(gitDir, defaultBranchRef);
      const refDir = path.dirname(refPath);
      if (!fs.existsSync(refDir)) {
        fs.mkdirSync(refDir, { recursive: true });
      }
      fs.writeFileSync(refPath, headSha + "\n");
      console.error(`Wrote ref ${defaultBranchRef} -> ${headSha}`);

      fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: ${defaultBranchRef}\n`);
      console.error(`Updated .git/HEAD to point to ${defaultBranchRef}`);
    } else {
      fs.writeFileSync(path.join(gitDir, "HEAD"), `${headSha}\n`);
      console.error(`Wrote detached HEAD pointing to ${headSha}`);
    }

    console.log(`Attempting checkout for commit: ${headSha}`);
    try {
      await checkout(headSha, ".");
      console.log(`Checkout completed for commit ${headSha}.`);
    } catch (checkoutError) {
      console.error(`Checkout failed: ${checkoutError.message}`);
      console.error("This might be due to missing objects (e.g., OFS_DELTA not supported) or other errors during object processing.");
    }

    console.log(`Clone completed into ${targetDir}. NOTE: OFS_DELTA objects are still skipped. Checkout may be incomplete if they were required.`);
  } catch (error) {
    console.error(`Cloning failed: ${error.message}`);
    throw error;
  } finally {
    process.chdir(originalCwd);
  }
}

async function processPackfile(packData) {
  if (packData.length < 12 + 20) {
    throw new Error(`Invalid packfile: Too short (${packData.length} bytes) for header and checksum`);
  }
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

  console.log("Packfile parsing: Attempting to process non-delta and REF_DELTA objects. OFS_DELTA objects are still skipped.");

  while (objectsProcessed < numObjects && offset < packData.length - 20) {
    const initialOffset = offset;
    let isDelta = false;
    let objectTypeStr = null;
    let size = -1;
    let headerSize = 0;
    let baseSha = null;
    let baseObjectNegativeOffset = -1;

    try {
      let byte = packData[offset++];
      const type = (byte >> 4) & 0x7;
      size = byte & 0xf;
      let shift = 4;
      while (byte & 0x80) {
        if (offset >= packData.length - 20) throw new Error("EOF reading size");
        byte = packData[offset++];
        size |= (byte & 0x7f) << shift;
        shift += 7;
      }
      headerSize = offset - initialOffset;

      switch (type) {
        case 1: objectTypeStr = 'commit'; break;
        case 2: objectTypeStr = 'tree'; break;
        case 3: objectTypeStr = 'blob'; break;
        case 4: objectTypeStr = 'tag'; break;
        case 6:
          isDelta = true;
          objectTypeStr = 'OFS_DELTA';
          let negOffsetByte = packData[offset++];
          baseObjectNegativeOffset = negOffsetByte & 0x7f;
          while (negOffsetByte & 0x80) {
            if (offset >= packData.length - 20) throw new Error("EOF reading OFS_DELTA offset");
            negOffsetByte = packData[offset++];
            baseObjectNegativeOffset = ((baseObjectNegativeOffset + 1) << 7) | (negOffsetByte & 0x7f);
          }
          headerSize = offset - initialOffset;
          console.warn(`Skipping OFS_DELTA object at offset ${initialOffset} (size ${size}, base offset ${baseObjectNegativeOffset}). Reconstruction not implemented.`);
          break;
        case 7:
          isDelta = true;
          objectTypeStr = 'REF_DELTA';
          if (offset + 20 > packData.length - 20) throw new Error("EOF reading REF_DELTA base SHA");
          baseSha = packData.slice(offset, offset + 20).toString('hex');
          offset += 20;
          headerSize = offset - initialOffset;
          console.log(`Found REF_DELTA object at offset ${initialOffset} (target size ${size}, base ${baseSha})`);
          break;
        default:
          throw new Error(`Unknown object type ${type} at offset ${initialOffset}`);
      }

      if (offset >= packData.length - 20 && objectsProcessed < numObjects - 1) {
        console.warn(`Warning: Reached end of pack data unexpectedly after reading header for object ${objectsProcessed + 1}`);
        break;
      }

      const remainingCompressedData = packData.slice(offset, packData.length - 20);
      if (remainingCompressedData.length === 0 && (size > 0 || isDelta)) {
        console.warn(`No data remaining for object type ${type} at offset ${offset} but header indicated size ${size} or delta`);
        objectsProcessed++;
        continue;
      }

      let consumedCompressedBytes = 0;
      let objectContent = null;
      let finalObjectType = null;

      let decompressedData = null;
      const inflate = zlib.createInflate();
      let tempDecompressed = Buffer.alloc(0);
      let decompressionError = null;

      await new Promise((resolveInflate, rejectInflate) => {
        inflate.on('data', (chunk) => {
          tempDecompressed = Buffer.concat([tempDecompressed, chunk]);
        });
        inflate.on('end', () => {
          consumedCompressedBytes = inflate.bytesRead || 0;
          decompressedData = tempDecompressed;
          console.log(`Decompression ended for object at ${initialOffset}. Compressed bytes consumed: ${consumedCompressedBytes}. Decompressed size: ${decompressedData?.length}`);
          resolveInflate();
        });
        inflate.on('error', (err) => {
          consumedCompressedBytes = inflate.bytesRead || remainingCompressedData.length;
          decompressionError = err;
          console.error(`Decompression error for object at offset ${initialOffset}: ${err.message}`);
          rejectInflate(err);
        });

        if (remainingCompressedData.length > 0) {
          inflate.write(remainingCompressedData);
        }
        inflate.end();
      }).catch(err => {
        console.warn(`Caught decompression error for object at ${initialOffset}. Skipping object.`);
      });

      if (decompressionError) {
        offset = initialOffset + headerSize + consumedCompressedBytes;
        objectsProcessed++;
        continue;
      }

      if (!isDelta) {
        finalObjectType = objectTypeStr;
        objectContent = decompressedData;

        if (objectContent.length !== size) {
          console.error(`CRITICAL: Decompressed size (${objectContent.length}) != header size (${size}) for ${finalObjectType} at ${initialOffset}. Object might be corrupted or header misread.`);
          offset = initialOffset + headerSize + consumedCompressedBytes;
          objectsProcessed++;
          continue;
        }
        console.log(`Processing non-delta object: ${finalObjectType} at offset ${initialOffset}, size ${size}`);
      } else if (objectTypeStr === 'REF_DELTA') {
        console.log(`Attempting to reconstruct REF_DELTA object based on ${baseSha}`);
        try {
          const baseObject = await readObject(baseSha);
          if (!baseObject) {
            throw new Error(`Base object ${baseSha} for REF_DELTA at offset ${initialOffset} not found. Cannot reconstruct.`);
          }
          finalObjectType = baseObject.type;
          console.log(`Base object ${baseSha} (type ${baseObject.type}) found. Applying delta...`);

          objectContent = applyDelta(baseObject.content, decompressedData);

          if (objectContent.length !== size) {
            console.warn(`Warning: Reconstructed delta size (${objectContent.length}) does not match expected target size (${size}) from pack header for delta at ${initialOffset}. Using reconstructed size.`);
          }
          console.log(`Successfully reconstructed object from REF_DELTA at ${initialOffset}. Final type: ${finalObjectType}, size: ${objectContent.length}`);
        } catch (deltaError) {
          console.error(`Failed to reconstruct REF_DELTA object at offset ${initialOffset}: ${deltaError.message}`);
          offset = initialOffset + headerSize + consumedCompressedBytes;
          objectsProcessed++;
          continue;
        }
      } else if (objectTypeStr === 'OFS_DELTA') {
        console.warn(`Skipping OFS_DELTA at ${initialOffset} as planned.`);
        offset = initialOffset + headerSize + consumedCompressedBytes;
        objectsProcessed++;
        continue;
      }

      if (objectContent !== null && finalObjectType !== null) {
        try {
          const sha = writeGitObject(finalObjectType, objectContent);
          writtenObjects[sha] = finalObjectType;
          console.log(`Successfully wrote object ${sha} (${finalObjectType}), size ${objectContent.length}`);
          objectInfoByOffset[initialOffset] = { sha: sha, type: finalObjectType, size: objectContent.length, headerSize: headerSize, compressedSize: consumedCompressedBytes };
        } catch (writeError) {
          console.error(`Failed to write object (type ${finalObjectType}, size ${objectContent.length}) originating from offset ${initialOffset}: ${writeError.message}`);
        }
      } else if (!isDelta && size === 0) {
        if (objectTypeStr === 'blob') {
          const sha = writeGitObject('blob', Buffer.alloc(0));
          writtenObjects[sha] = 'blob';
          console.log(`Successfully processed and wrote empty blob ${sha}`);
          objectInfoByOffset[initialOffset] = { sha: sha, type: 'blob', size: 0, headerSize: headerSize, compressedSize: 0 };
        } else {
          console.log(`Processed zero-size object ${objectTypeStr} at ${initialOffset}`);
        }
        consumedCompressedBytes = 0;
      }

      const nextObjectOffset = initialOffset + headerSize + consumedCompressedBytes;
      console.log(`Object at ${initialOffset}: headerSize=${headerSize}, consumedCompressedBytes=${consumedCompressedBytes}. Next object expected at ${nextObjectOffset}`);
      offset = nextObjectOffset;
    } catch (err) {
      console.error(`Failed processing object starting at offset ${initialOffset}: ${err.message}`);
      console.error("Stopping packfile processing due to error.");
      break;
    }

    objectsProcessed++;
  }

  if (objectsProcessed < numObjects) {
    console.warn(`Processed only ${objectsProcessed} out of ${numObjects} objects indicated in header.`);
  } else {
    console.log(`Finished processing ${objectsProcessed} objects.`);
  }
  const calculatedChecksum = crypto.createHash('sha1').update(packData.slice(0, packData.length - 20)).digest('hex');
  const expectedChecksum = packData.slice(packData.length - 20).toString('hex');
  if (calculatedChecksum !== expectedChecksum) {
    console.warn(`Packfile checksum mismatch! Expected: ${expectedChecksum}, Calculated: ${calculatedChecksum}`);
  } else {
    console.log("Packfile checksum verified.");
  }

  return writtenObjects;
}

async function checkout(commitSha, targetDirectory) {
  const commitData = await readObject(commitSha);
  if (!commitData) {
    throw new Error(`Commit object ${commitSha} not found. Cannot checkout.`);
  }
  if (commitData.type !== 'commit') {
    throw new Error(`Object ${commitSha} is not a commit (type: ${commitData.type})`);
  }

  const commitContent = commitData.content.toString();
  const treeMatch = commitContent.match(/^tree ([0-9a-f]{40})$/m);
  if (!treeMatch) {
    throw new Error(`Could not find tree SHA in commit ${commitSha}`);
  }
  const treeSha = treeMatch[1];
  console.log(`Checking out tree ${treeSha} for commit ${commitSha}`);

  if (!fs.existsSync(targetDirectory)) {
    fs.mkdirSync(targetDirectory, { recursive: true });
  }

  await checkoutTree(treeSha, targetDirectory);
}

async function checkoutTree(treeSha, currentPath) {
  const treeData = await readObject(treeSha);
  if (!treeData) {
    console.error(`Tree object ${treeSha} not found. Skipping checkout for path ${currentPath}`);
    return;
  }
  if (treeData.type !== 'tree') {
    throw new Error(`Object ${treeSha} is not a tree (type: ${treeData.type})`);
  }

  let offset = 0;
  const treeContent = treeData.content;

  while (offset < treeContent.length) {
    const spaceIndex = treeContent.indexOf(0x20, offset);
    if (spaceIndex === -1) break;
    const mode = treeContent.slice(offset, spaceIndex).toString();

    const nullIndex = treeContent.indexOf(0x00, spaceIndex + 1);
    if (nullIndex === -1) break;
    const name = treeContent.slice(spaceIndex + 1, nullIndex).toString();

    const shaBytes = treeContent.slice(nullIndex + 1, nullIndex + 1 + 20);
    if (shaBytes.length < 20) break;
    const entrySha = shaBytes.toString('hex');

    const entryPath = path.join(currentPath, name);

    if (mode === '40000') {
      console.log(`Creating directory ${entryPath} and checking out tree ${entrySha}`);
      if (!fs.existsSync(entryPath)) {
        fs.mkdirSync(entryPath, { recursive: true });
      }
      await checkoutTree(entrySha, entryPath);
    } else {
      console.log(`Writing file ${entryPath} from blob ${entrySha}`);
      const blobData = await readObject(entrySha);
      if (blobData && blobData.type === 'blob') {
        fs.writeFileSync(entryPath, blobData.content);
        if (mode === '100755') {
          try { fs.chmodSync(entryPath, 0o755); } catch (e) { console.warn(`Failed to set executable bit on ${entryPath}: ${e.message}`); }
        } else {
          try { fs.chmodSync(entryPath, 0o644); } catch (e) { console.warn(`Failed to set file mode on ${entryPath}: ${e.message}`); }
        }
      } else {
        console.error(`Blob object ${entrySha} for file ${entryPath} not found or not a blob. Skipping file.`);
      }
    }

    offset = nullIndex + 1 + 20;
  }
}

module.exports = { cloneCommand };
