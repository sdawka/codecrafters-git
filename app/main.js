// Import command handlers
const { initCommand } = require("./commands/init");
const { catFileCommand } = require("./commands/catFile");
const { hashObjectCommand } = require("./commands/hashObject");
const { lsTreeCommand } = require("./commands/lsTree");
const { writeTreeCommand } = require("./commands/writeTree");

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
