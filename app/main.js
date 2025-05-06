// Import command handlers
const { initCommand } = require("./commands/init");
const { catFileCommand } = require("./commands/catFile");
const { hashObjectCommand } = require("./commands/hashObject");
const { lsTreeCommand } = require("./commands/lsTree");
const { writeTreeCommand } = require("./commands/writeTree");
const { commitTreeCommand } = require("./commands/commitTree"); // Import the new command
const { cloneCommand } = require("./commands/clone"); // Import the clone command

// You can use print statements as follows for debugging, they'll be visible when running tests.
console.error("Logs from your program will appear here!");

// Uncomment this block to pass the first stage
const command = process.argv[2];

try { // Add a try-catch block for better error handling at the top level
  switch (command) {
    case "init":
      initCommand();
      break;
    case "cat-file":
      if (process.argv[3] === "-p" && process.argv.length > 4) {
        const objectHash = process.argv[4];
        catFileCommand(objectHash);
      } else {
        // Provide more specific error messages
        if (process.argv[3] !== "-p") {
           throw new Error("cat-file command requires the -p option");
        } else {
           throw new Error("cat-file command requires an object hash");
        }
      }
      break;
    case "hash-object":
      let writeObject = false;
      let filePathIndex = 3;
      if (process.argv[3] === "-w") {
        writeObject = true;
        filePathIndex = 4;
      }
      const filePath = process.argv[filePathIndex];
      if (!filePath) {
        throw new Error("hash-object command requires a file path");
      }
      hashObjectCommand(filePath, writeObject);
      break;
    case "ls-tree":
      let nameOnly = false;
      let treeHashIndex = 3;
      if (process.argv[3] === "--name-only") {
        nameOnly = true;
        treeHashIndex = 4;
      }
      const treeHash = process.argv[treeHashIndex];
      if (!treeHash) {
        throw new Error("ls-tree command requires a tree hash");
      }
      lsTreeCommand(treeHash, nameOnly);
      break;
    case "write-tree":
      // write-tree doesn't take arguments in this basic implementation
      const treeSha = writeTreeCommand(); // Call the imported function
      console.log(treeSha);
      break;
    case "commit-tree":
      // Parse arguments: commit-tree <tree_sha> -p <commit_sha> -m <message>
      const treeShaArg = process.argv[3];
      const parentFlagIndex = process.argv.indexOf("-p");
      const messageFlagIndex = process.argv.indexOf("-m");

      if (!treeShaArg || parentFlagIndex === -1 || messageFlagIndex === -1 ||
          parentFlagIndex + 1 >= process.argv.length || messageFlagIndex + 1 >= process.argv.length) {
        throw new Error("Usage: commit-tree <tree_sha> -p <commit_sha> -m <message>");
      }

      const parentShaArg = process.argv[parentFlagIndex + 1];
      // Combine message parts if they contain spaces
      const messageArg = process.argv.slice(messageFlagIndex + 1).join(' ');

      const commitSha = commitTreeCommand(treeShaArg, parentShaArg, messageArg);
      console.log(commitSha);
      break;
    case "clone":
      const repoUrl = process.argv[3];
      const targetDir = process.argv[4]; // Optional target directory
      if (!repoUrl) {
        throw new Error("Usage: clone <repository_url> [directory]");
      }
      // We'll make cloneCommand async later when handling HTTP requests
      cloneCommand(repoUrl, targetDir);
      break;
    default:
      throw new Error(`Unknown command ${command}`);
  }
} catch (error) {
    // Catch errors from commands and print a user-friendly message
    console.error(`Error executing command '${command}': ${error.message}`);
    // Optionally, uncomment the line below for more detailed stack traces during development
    // console.error(error.stack); 
    process.exit(1); // Exit with a non-zero code to indicate failure
}
