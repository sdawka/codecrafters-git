const fs = require("fs");
const path = require("path");
const { readObject } = require("./objectUtils");

/**
 * Checks out a Git tree to a directory
 * @param {string} treeSha - The SHA-1 of the tree to checkout
 * @param {string} targetDirectory - The directory to checkout to
 * @returns {Promise<void>}
 */
async function checkoutTree(treeSha, targetDirectory) {
  const treeData = await readObject(treeSha);
  if (!treeData) {
    console.error(`Tree object ${treeSha} not found. Skipping checkout for path ${targetDirectory}`);
    return;
  }
  
  if (treeData.type !== 'tree') {
    throw new Error(`Object ${treeSha} is not a tree (type: ${treeData.type})`);
  }

  if (!fs.existsSync(targetDirectory)) {
    fs.mkdirSync(targetDirectory, { recursive: true });
  }

  let offset = 0;
  const treeContent = treeData.content;

  while (offset < treeContent.length) {
    // Parse mode
    const spaceIndex = treeContent.indexOf(0x20, offset);
    if (spaceIndex === -1) break;
    const mode = treeContent.slice(offset, spaceIndex).toString();

    // Parse name
    const nullIndex = treeContent.indexOf(0x00, spaceIndex + 1);
    if (nullIndex === -1) break;
    const name = treeContent.slice(spaceIndex + 1, nullIndex).toString();

    // Parse SHA
    const shaBytes = treeContent.slice(nullIndex + 1, nullIndex + 1 + 20);
    if (shaBytes.length < 20) break;
    const entrySha = shaBytes.toString('hex');

    const entryPath = path.join(targetDirectory, name);

    if (mode === '40000') {
      // Directory entry - recursively checkout subtree
      console.log(`Creating directory ${entryPath} and checking out tree ${entrySha}`);
      await checkoutTree(entrySha, entryPath);
    } else {
      // File entry - write blob content
      console.log(`Writing file ${entryPath} from blob ${entrySha}`);
      const blobData = await readObject(entrySha);
      if (blobData && blobData.type === 'blob') {
        fs.writeFileSync(entryPath, blobData.content);
        // Set executable bit if appropriate
        if (mode === '100755') {
          try { 
            fs.chmodSync(entryPath, 0o755); 
          } catch (e) { 
            console.warn(`Failed to set executable bit on ${entryPath}: ${e.message}`); 
          }
        } else {
          try { 
            fs.chmodSync(entryPath, 0o644); 
          } catch (e) { 
            console.warn(`Failed to set file mode on ${entryPath}: ${e.message}`); 
          }
        }
      } else {
        console.error(`Blob object ${entrySha} for file ${entryPath} not found or not a blob. Skipping file.`);
      }
    }

    offset = nullIndex + 1 + 20;
  }
}

/**
 * Checks out a Git commit
 * @param {string} commitSha - The SHA-1 of the commit to checkout
 * @param {string} targetDirectory - The directory to checkout to
 * @returns {Promise<void>}
 */
async function checkoutCommit(commitSha, targetDirectory) {
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

/**
 * Updates a Git reference
 * @param {string} refName - The name of the reference to update (e.g., 'refs/heads/main')
 * @param {string} sha - The SHA-1 to set the reference to
 * @param {boolean} isSymbolic - Whether the reference is symbolic
 * @returns {void}
 */
function updateRef(refName, sha, isSymbolic = false) {
  const gitDir = path.join(process.cwd(), ".git");
  const refPath = path.join(gitDir, refName);
  const refDir = path.dirname(refPath);
  
  if (!fs.existsSync(refDir)) {
    fs.mkdirSync(refDir, { recursive: true });
  }
  
  const content = isSymbolic ? `ref: ${sha}\n` : `${sha}\n`;
  fs.writeFileSync(refPath, content);
  console.log(`Updated reference ${refName} -> ${sha}`);
}

module.exports = {
  checkoutTree,
  checkoutCommit,
  updateRef
};