const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { writeGitObject } = require("../utils/objectUtils"); // Assuming object writing logic is refactored

function commitTreeCommand(treeSha, parentSha, message) {
  // Hardcode author and committer details (replace with actual logic if needed)
  const authorName = "Your Name";
  const authorEmail = "your.email@example.com";
  const committerName = authorName;
  const committerEmail = authorEmail;

  // Get current timestamp in Git format (seconds since epoch + timezone offset)
  const timestamp = Math.floor(Date.now() / 1000);
  const timezoneOffset = new Date().getTimezoneOffset();
  const timezoneHours = Math.floor(Math.abs(timezoneOffset) / 60).toString().padStart(2, '0');
  const timezoneMinutes = (Math.abs(timezoneOffset) % 60).toString().padStart(2, '0');
  const timezoneSign = timezoneOffset <= 0 ? '+' : '-';
  const timezone = `${timezoneSign}${timezoneHours}${timezoneMinutes}`;

  // Construct the commit content
  let commitContent = `tree ${treeSha}
`;
  commitContent += `parent ${parentSha}
`;
  commitContent += `author ${authorName} <${authorEmail}> ${timestamp} ${timezone}
`;
  commitContent += `committer ${committerName} <${committerEmail}> ${timestamp} ${timezone}
`;
  commitContent += `
`; // Blank line separator
  commitContent += `${message}
`; // Commit message

  // Use the utility function to write the commit object and get its SHA
  const commitSha = writeGitObject("commit", Buffer.from(commitContent, "utf-8"));

  return commitSha;
}

module.exports = { commitTreeCommand };
