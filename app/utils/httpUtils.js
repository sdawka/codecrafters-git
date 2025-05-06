const https = require("https");

/**
 * Makes an HTTPS GET request and returns the response as a Buffer
 * @param {string} url - The URL to make the request to
 * @param {Object} headers - Optional headers for the request
 * @returns {Promise<Buffer>} - The response body as a Buffer
 */
async function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'User-Agent': 'git/codecrafters-git-js'
    };
    
    const options = {
      headers: { ...defaultHeaders, ...headers }
    };

    const req = https.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP request failed: ${res.statusCode}`));
      }
      
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          resolve(buffer);
        } catch (err) {
          reject(new Error(`Failed to process response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`HTTP request error: ${err.message}`));
    });

    req.end();
  });
}

/**
 * Makes an HTTPS POST request and returns the response as a Buffer
 * @param {string} url - The URL to make the request to
 * @param {Buffer|string} body - The request body
 * @param {Object} headers - Optional headers for the request
 * @returns {Promise<Buffer>} - The response body as a Buffer
 */
async function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'User-Agent': 'git/codecrafters-git-js'
    };
    
    const options = {
      method: 'POST',
      headers: { ...defaultHeaders, ...headers }
    };

    const req = https.request(url, options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP request failed: ${res.statusCode}`));
      }
      
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          resolve(buffer);
        } catch (err) {
          reject(new Error(`Failed to process response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`HTTP request error: ${err.message}`));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

module.exports = { httpsGet, httpsPost };