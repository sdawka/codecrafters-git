const fs = require("fs");
const path = require("path");
const { initCommand } = require("./init");
const { processPackfile } = require("../utils/packfileParser");
const { discoverRefs, requestPackfile } = require("../utils/gitProtocol");
const { checkoutCommit, updateRef } = require("../utils/repositoryUtils");

/**
 * Clones a Git repository
 * @param {string} repoUrl - The URL of the Git repository to clone
 * @param {string} targetDir - The directory to clone into
 * @returns {Promise<void>}
 */
async function cloneCommand(repoUrl, targetDir) {
  console.error(`Cloning from ${repoUrl}`);

  const parsedUrl = new URL(repoUrl);
  if (!targetDir) {
    targetDir = path.basename(parsedUrl.pathname).replace(/\.git$/, "");
  }

  if (fs.existsSync(targetDir)) {
    throw new Error(`Target directory "${targetDir}" already exists.`);
  }

  // Discover refs in the remote repository
  const refs = await discoverRefs(repoUrl);
  console.error("Discovered refs:", Object.keys(refs));

  // Determine the default branch and HEAD commit
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

  // Create the target directory and initialize Git repository
  const originalCwd = process.cwd();
  fs.mkdirSync(targetDir);
  process.chdir(targetDir);
  
  try {
    // Initialize a new Git repository
    initCommand();

    // Request and process packfile
    console.error(`Requesting packfile for target: ${headSha}...`);
    const packfileData = await requestPackfile(repoUrl, [headSha]);
    console.error(`Received packfile data (size: ${packfileData.length})`);

    console.error("Processing packfile (handling non-delta and REF_DELTA)...");
    const objectsInfo = await processPackfile(packfileData);
    console.error(`Stored ${Object.keys(objectsInfo).length} objects (including reconstructed deltas) from packfile.`);
    
    if (Object.keys(objectsInfo).length === 0 && packfileData.length > 20) {
      console.warn("No objects were extracted. Checkout will likely fail.");
    }

    // Update refs and HEAD
    if (defaultBranchRef) {
      updateRef(defaultBranchRef, headSha);
      updateRef("HEAD", defaultBranchRef, true);
    } else {
      updateRef("HEAD", headSha);
    }

    // Checkout files
    console.log(`Attempting checkout for commit: ${headSha}`);
    try {
      await checkoutCommit(headSha, ".");
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

module.exports = { cloneCommand };
