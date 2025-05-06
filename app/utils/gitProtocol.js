const { httpsGet, httpsPost } = require('../utils/httpUtils');

/**
 * Parses a Git pkt-line formatted buffer into a map of references
 * @param {Buffer} buffer - The buffer containing pkt-line formatted data
 * @returns {Object} - Map of reference names to their SHA-1 values
 */
function parsePktLine(buffer) {
  const refs = {};
  let offset = 0;
  let firstLine = true; // To handle the capabilities line

  while (offset < buffer.length) {
    const lengthHex = buffer.slice(offset, offset + 4).toString();
    if (lengthHex === '0000') { // Flush packet
      offset += 4;
      continue;
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

/**
 * Formats Git pkt-line data
 * @param {string} line - The line to encode
 * @returns {string} - The pkt-line encoded string
 */
function formatPktLine(line) {
  const length = line.length + 4; // 4 bytes for the length itself
  return `${length.toString(16).padStart(4, '0')}${line}`;
}

/**
 * Formats a flush packet
 * @returns {string} - The flush packet
 */
function formatFlushPkt() {
  return '0000';
}

/**
 * Discovers Git references from a remote repository
 * @param {string} repoUrl - The URL of the Git repository
 * @returns {Promise<Object>} - Map of reference names to their SHA-1 values
 */
async function discoverRefs(repoUrl) {
  const parsedUrl = new URL(repoUrl);
  const infoRefsUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}/info/refs?service=git-upload-pack`;
  console.error(`Discovering refs from ${infoRefsUrl}`);

  try {
    const buffer = await httpsGet(infoRefsUrl);
    
    // Skip the initial service announcement
    let startOffset = 0;
    const firstLengthHex = buffer.slice(0, 4).toString();
    const firstLength = parseInt(firstLengthHex, 16);
    if (firstLength > 0 && buffer.slice(4, firstLength).toString().startsWith('# service=')) {
      startOffset = firstLength;
    }
    
    // Parse the refs
    return parsePktLine(buffer.slice(startOffset));
  } catch (err) {
    throw new Error(`Failed to discover refs: ${err.message}`);
  }
}

/**
 * Constructs a Git protocol request body for requesting a packfile
 * @param {Array<string>} wantShas - The SHA-1 commits to request
 * @returns {string} - Formatted request body
 */
function constructPackfileRequest(wantShas) {
  if (!wantShas || wantShas.length === 0) {
    throw new Error("No SHAs provided to request packfile.");
  }
  
  let body = '';
  // First want line includes capabilities
  const firstWant = `want ${wantShas[0]} multi_ack_detailed side-band-64k thin-pack ofs-delta agent=git/codecrafters-git-js`;
  body += formatPktLine(firstWant);
  
  // Additional want lines
  for (let i = 1; i < wantShas.length; i++) {
    const wantLine = `want ${wantShas[i]}`;
    body += formatPktLine(wantLine);
  }
  
  // Add flush packet between wants and done
  body += formatFlushPkt();
  
  // Add done line
  body += formatPktLine('done');
  
  // Add final flush packet
  body += formatFlushPkt();
  
  return body;
}

/**
 * Requests a packfile from a remote repository
 * @param {string} repoUrl - The URL of the Git repository
 * @param {Array<string>} wantShas - The SHA-1 commits to request
 * @returns {Promise<Buffer>} - The packfile data
 */
async function requestPackfile(repoUrl, wantShas) {
  if (!wantShas || wantShas.length === 0) {
    throw new Error("No SHAs provided to request packfile.");
  }
  
  const parsedUrl = new URL(repoUrl);
  const uploadPackUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}/git-upload-pack`;
  console.error(`Requesting packfile from ${uploadPackUrl}`);

  try {
    const body = constructPackfileRequest(wantShas);
    
    const headers = {
      'Content-Type': 'application/x-git-upload-pack-request',
      'Accept': 'application/x-git-upload-pack-result'
    };
    
    const response = await httpsPost(uploadPackUrl, body, headers);
    
    // Process the response to extract the packfile
    return extractPackfile(response);
  } catch (err) {
    throw new Error(`Failed to request packfile: ${err.message}`);
  }
}

/**
 * Extracts the packfile from a Git upload-pack response
 * @param {Buffer} buffer - The response buffer
 * @returns {Buffer} - The extracted packfile
 */
function extractPackfile(buffer) {
  const packHeaderIndex = buffer.indexOf('PACK');
  if (packHeaderIndex === -1) {
    let errorMessage = "Packfile signature 'PACK' not found in response.";
    
    // Try to extract error messages from sideband
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

    throw new Error(errorMessage);
  }

  // Extract packfile data from sideband
  let packData = Buffer.alloc(0);
  let offset = 0;
  
  while (offset < buffer.length) {
    const lengthHex = buffer.slice(offset, offset + 4).toString();
    if (lengthHex === '0000') {
      offset += 4;
      // Check if we've reached the raw packfile
      if (offset < buffer.length && buffer.slice(offset).indexOf('PACK') === 0) {
        packData = Buffer.concat([packData, buffer.slice(offset)]);
        break;
      }
      continue;
    }
    
    const length = parseInt(lengthHex, 16);
    if (length === 0 || offset + length > buffer.length) {
      console.warn(`Invalid sideband length at offset ${offset}. Stopping pack data extraction.`);
      break;
    }
    
    const indicator = buffer[offset + 4];
    const dataSlice = buffer.slice(offset + 5, offset + length);
    
    if (indicator === 1) {
      // Data band - could contain pack data
      const packIndexInData = dataSlice.indexOf('PACK');
      if (packIndexInData !== -1) {
        packData = Buffer.concat([packData, dataSlice.slice(packIndexInData)]);
      } else if (packData.length > 0) {
        packData = Buffer.concat([packData, dataSlice]);
      }
    } else if (indicator === 2) {
      // Progress messages
      console.error(`Progress: ${dataSlice.toString('utf-8').trim()}`);
    } else if (indicator === 3) {
      // Error messages
      console.error(`Error from server: ${dataSlice.toString('utf-8').trim()}`);
    }
    
    offset += length;
  }
  
  if (packData.length === 0 || packData.indexOf('PACK') !== 0) {
    throw new Error("Could not extract valid PACK data from response.");
  }
  
  return packData;
}

module.exports = {
  parsePktLine,
  formatPktLine,
  formatFlushPkt,
  discoverRefs,
  requestPackfile
};