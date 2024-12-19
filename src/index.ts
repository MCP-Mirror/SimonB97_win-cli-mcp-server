#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { 
  isCommandBlocked,
  isArgumentBlocked,
  parseCommand,
  extractCommandName,
  validateShellOperators
} from './utils/validation.js';
import { spawn } from 'child_process';
import { z } from 'zod';
import path from 'path';
import { loadConfig, createDefaultConfig } from './utils/config.js';
import type { ServerConfig, CommandHistoryEntry, SSHConnectionConfig } from './types/config.js';
import { SSHConnectionPool } from './utils/ssh.js';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

// Parse command line arguments using yargs
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

const parseArgs = async () => {
  return yargs(hideBin(process.argv))
    .option('config', {
      alias: 'c',
      type: 'string',
      description: 'Path to config file'
    })
    .option('init-config', {
      type: 'string',
      description: 'Create a default config file at the specified path'
    })
    .help()
    .parse();
};

class CLIServer {
  private server: Server;
  private allowedPaths: Set<string>;
  private blockedCommands: Set<string>;
  private commandHistory: CommandHistoryEntry[];
  private config: ServerConfig;
  private sshPool: SSHConnectionPool;

  constructor(config: ServerConfig) {
    this.config = config;
    this.server = new Server({
      name: "windows-cli-server",
      version: packageJson.version,
    }, {
      capabilities: {
        tools: {}
      }
    });

    // Initialize from config
    this.allowedPaths = new Set(config.security.allowedPaths);
    this.blockedCommands = new Set(config.security.blockedCommands);
    this.commandHistory = [];
    this.sshPool = new SSHConnectionPool();

    this.setupHandlers();
  }

  private validateCommand(shell: keyof ServerConfig['shells'], command: string): void {
    // Check for command chaining/injection attempts if enabled
    if (this.config.security.enableInjectionProtection) {
      // Get shell-specific config
      const shellConfig = this.config.shells[shell];
      
      // Use shell-specific operator validation
      validateShellOperators(command, shellConfig);
    }
  
    const { command: executable, args } = parseCommand(command);
  
    // Check for blocked commands
    if (isCommandBlocked(executable, Array.from(this.blockedCommands))) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Command is blocked: "${extractCommandName(executable)}"`
      );
    }
  
    // Check for blocked arguments
    if (isArgumentBlocked(args, this.config.security.blockedArguments)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'One or more arguments are blocked. Check configuration for blocked patterns.'
      );
    }
  
    // Validate command length
    if (command.length > this.config.security.maxCommandLength) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Command exceeds maximum length of ${this.config.security.maxCommandLength}`
      );
    }
  }

  /**
   * Escapes special characters in a string for use in a regular expression
   * @param text The string to escape
   * @returns The escaped string
   */
  private escapeRegex(text: string): string {
    return text.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "execute_command",
          description: `Execute a command in the specified shell (powershell, cmd, or gitbash)

Example usage (PowerShell):
\`\`\`json
{
  "shell": "powershell",
  "command": "Get-Process | Select-Object -First 5",
  "workingDir": "C:\\Users\\username"
}
\`\`\`

Example usage (CMD):
\`\`\`json
{
  "shell": "cmd",
  "command": "dir /b",
  "workingDir": "C:\\Projects"
}
\`\`\`

Example usage (Git Bash):
\`\`\`json
{
  "shell": "gitbash",
  "command": "ls -la",
  "workingDir": "/c/Users/username"
}
\`\`\``,
          inputSchema: {
            type: "object",
            properties: {
              shell: {
                type: "string",
                enum: Object.keys(this.config.shells).filter(shell => 
                  this.config.shells[shell as keyof typeof this.config.shells].enabled
                ),
                description: "Shell to use for command execution"
              },
              command: {
                type: "string",
                description: "Command to execute"
              },
              workingDir: {
                type: "string",
                description: "Working directory for command execution (optional)"
              }
            },
            required: ["shell", "command"]
          }
        },
        {
          name: "get_command_history",
          description: `Get the history of executed commands

Example usage:
\`\`\`json
{
  "limit": 5
}
\`\`\`

Example response:
\`\`\`json
[
  {
    "command": "Get-Process",
    "output": "...",
    "timestamp": "2024-03-20T10:30:00Z",
    "exitCode": 0
  }
]
\`\`\``,
          inputSchema: {
            type: "object",
            properties: {
              limit: {
                type: "number",
                description: `Maximum number of history entries to return (default: 10, max: ${this.config.security.maxHistorySize})`
              }
            }
          }
        },
        {
          name: "ssh_execute",
          description: `Execute a command on a remote host via SSH

Example usage:
\`\`\`json
{
  "connectionId": "raspberry-pi",
  "command": "uname -a"
}
\`\`\`

Configuration required in config.json:
\`\`\`json
{
  "ssh": {
    "enabled": true,
    "connections": {
      "raspberry-pi": {
        "host": "raspberrypi.local",
        "port": 22,
        "username": "pi",
        "password": "raspberry"
      }
    }
  }
}
\`\`\``,
          inputSchema: {
            type: "object",
            properties: {
              connectionId: {
                type: "string",
                description: "ID of the SSH connection to use",
                enum: Object.keys(this.config.ssh.connections)
              },
              command: {
                type: "string",
                description: "Command to execute"
              }
            },
            required: ["connectionId", "command"]
          }
        },
        {
          name: "ssh_disconnect",
          description: `Disconnect from an SSH server

Example usage:
\`\`\`json
{
  "connectionId": "raspberry-pi"
}
\`\`\`

Use this to cleanly close SSH connections when they're no longer needed.`,
          inputSchema: {
            type: "object",
            properties: {
              connectionId: {
                type: "string",
                description: "ID of the SSH connection to disconnect",
                enum: Object.keys(this.config.ssh.connections)
              }
            },
            required: ["connectionId"]
          }
        }
      ]
    }));

    // Handle tool execution
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case "execute_command": {
            const args = z.object({
              shell: z.enum(Object.keys(this.config.shells).filter(shell => 
                this.config.shells[shell as keyof typeof this.config.shells].enabled
              ) as [string, ...string[]]),
              command: z.string(),
              workingDir: z.string().optional()
            }).parse(request.params.arguments);

            // Validate command
            this.validateCommand(args.shell as keyof ServerConfig['shells'], args.command);

            // Validate working directory if provided
            let workingDir = args.workingDir ? 
              path.resolve(args.workingDir) : 
              process.cwd();

            const shellKey = args.shell as keyof typeof this.config.shells;
            const shellConfig = this.config.shells[shellKey];
            
            if (this.config.security.restrictWorkingDirectory) {
              const isAllowedPath = Array.from(this.allowedPaths).some(
                allowedPath => workingDir.startsWith(allowedPath)
              );

              if (!isAllowedPath) {
                throw new McpError(
                  ErrorCode.InvalidRequest,
                  `Working directory (${workingDir}) outside allowed paths. Consult the server admin for configuration changes (config.json - restrictWorkingDirectory, allowedPaths).`
                );
              }
            }

            // Execute command
            return new Promise((resolve, reject) => {
              let shellProcess: ReturnType<typeof spawn>;
              
              try {
                shellProcess = spawn(
                  shellConfig.command,
                  [...shellConfig.args, args.command],
                  { cwd: workingDir, stdio: ['pipe', 'pipe', 'pipe'] }
                );
              } catch (err) {
                throw new McpError(
                  ErrorCode.InternalError,
                  `Failed to start shell process: ${err instanceof Error ? err.message : String(err)}. Consult the server admin for configuration changes (config.json - shells).`
                );
              }

              if (!shellProcess.stdout || !shellProcess.stderr) {
                throw new McpError(
                  ErrorCode.InternalError,
                  'Failed to initialize shell process streams'
                );
              }

              let output = '';
              let error = '';
              let outputSize = 0;
              let truncated = false;
              let outputFilePath: string | undefined;

              // Function to save output to file
              const saveToFile = (content: string) => {
                if (!this.config.security.outputDirectory) return;
                
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const filename = `output-${timestamp}.txt`;
                outputFilePath = path.join(this.config.security.outputDirectory, filename);
                
                fs.writeFileSync(outputFilePath, content, 'utf8');
                return outputFilePath;
              };

              shellProcess.stdout.on('data', (data) => {
                const chunk = data.toString();
                if (outputSize + chunk.length <= this.config.security.maxOutputSize) {
                  output += chunk;
                  outputSize += chunk.length;
                } else if (this.config.security.enableOutputFiles) {
                  // If this is the first time we're exceeding the limit
                  if (!truncated) {
                    // Save current output to file
                    output += chunk;
                    const filePath = saveToFile(output);
                    // Reset output to just show truncation message
                    output = `Output exceeded ${this.config.security.maxOutputSize / (1024 * 1024)}MB limit.\n`;
                    if (filePath) {
                      output += `Full output saved to: ${filePath}\n`;
                    }
                    truncated = true;
                  } else {
                    // Append to existing file
                    if (outputFilePath) {
                      fs.appendFileSync(outputFilePath, chunk);
                    }
                  }
                } else if (!truncated) {
                  output += '\n... Output truncated due to size limit ...';
                  truncated = true;
                }
              });

              shellProcess.stderr.on('data', (data) => {
                const chunk = data.toString();
                if (outputSize + chunk.length <= this.config.security.maxOutputSize) {
                  error += chunk;
                  outputSize += chunk.length;
                } else if (!truncated) {
                  error += '\n... Error output truncated due to size limit ...';
                  truncated = true;
                }
              });

              shellProcess.on('close', (code) => {
                let resultMessage = '';
                
                if (code === 0) {
                  resultMessage = output || 'Command completed successfully (no output)';
                  if (truncated) {
                    if (outputFilePath) {
                      resultMessage += `\n\nOutput exceeded ${this.config.security.maxOutputSize / (1024 * 1024)}MB limit and was saved to:\n${outputFilePath}`;
                    } else {
                      resultMessage += `\n\nOutput exceeded ${this.config.security.maxOutputSize / (1024 * 1024)}MB limit and was truncated.\nTo save large outputs to files, enable 'enableOutputFiles' in your config.json`;
                      if (this.config?.security?.outputDirectory) {
                        resultMessage += `\nOutputs will be saved to: ${this.config.security.outputDirectory}`;
                      } else {
                        resultMessage += `\nOutputs will be saved to: ${path.join(os.tmpdir(), 'win-cli-mcp-output')}`;
                      }
                    }
                  }
                } else {
                  resultMessage = `Command failed with exit code ${code}\n`;
                  if (error) {
                    resultMessage += `Error output:\n${error}\n`;
                  }
                  if (output) {
                    resultMessage += `Standard output:\n${output}`;
                  }
                  if (!error && !output) {
                    resultMessage += 'No error message or output was provided';
                  }
                  
                  // Inform about truncation if needed
                  if (truncated) {
                    if (outputFilePath) {
                      resultMessage += `\n\nOutput exceeded ${this.config.security.maxOutputSize / (1024 * 1024)}MB limit and was saved to:\n${outputFilePath}`;
                    } else {
                      resultMessage += `\n\nOutput exceeded ${this.config.security.maxOutputSize / (1024 * 1024)}MB limit and was truncated.\nTo save large outputs to files, enable 'enableOutputFiles' in your config.json`;
                      if (this.config?.security?.outputDirectory) {
                        resultMessage += `\nOutputs will be saved to: ${this.config.security.outputDirectory}`;
                      } else {
                        resultMessage += `\nOutputs will be saved to: ${path.join(os.tmpdir(), 'win-cli-mcp-output')}`;
                      }
                    }
                  }
                }

                // Store in history if enabled
                if (this.config.security.logCommands) {
                  this.commandHistory.push({
                    command: args.command,
                    output: resultMessage,
                    timestamp: new Date().toISOString(),
                    exitCode: code ?? -1
                  });

                  // Trim history if needed
                  if (this.commandHistory.length > this.config.security.maxHistorySize) {
                    this.commandHistory = this.commandHistory.slice(-this.config.security.maxHistorySize);
                  }
                }

                // Clean up old output files
                if (this.config.security.enableOutputFiles && this.config.security.outputDirectory) {
                  try {
                    const retentionMs = this.config.security.outputFileRetentionHours * 60 * 60 * 1000;
                    const cutoffTime = Date.now() - retentionMs;
                    
                    fs.readdirSync(this.config.security.outputDirectory)
                      .filter(file => file.startsWith('output-'))
                      .map(file => path.join(this.config.security.outputDirectory!, file))
                      .forEach(filePath => {
                        const stats = fs.statSync(filePath);
                        if (stats.mtimeMs < cutoffTime) {
                          fs.unlinkSync(filePath);
                        }
                      });
                  } catch (error) {
                    console.error('Error cleaning up old output files:', error);
                  }
                }

                resolve({
                  content: [{
                    type: "text",
                    text: resultMessage
                  }],
                  isError: code !== 0,
                  metadata: {
                    exitCode: code ?? -1,
                    shell: args.shell,
                    workingDirectory: workingDir
                  }
                });
              });

              // Handle process errors (e.g., shell crashes)
              shellProcess.on('error', (err) => {
                const errorMessage = `Shell process error: ${err.message}`;
                if (this.config.security.logCommands) {
                  this.commandHistory.push({
                    command: args.command,
                    output: errorMessage,
                    timestamp: new Date().toISOString(),
                    exitCode: -1
                  });
                }
                reject(new McpError(
                  ErrorCode.InternalError,
                  errorMessage
                ));
              });

              // Set configurable timeout to prevent hanging
              const timeout = setTimeout(() => {
                shellProcess.kill();
                const timeoutMessage = `Command execution timed out after ${this.config.security.commandTimeout} seconds. Consult the server admin for configuration changes (config.json - commandTimeout).`;
                if (this.config.security.logCommands) {
                  this.commandHistory.push({
                    command: args.command,
                    output: timeoutMessage,
                    timestamp: new Date().toISOString(),
                    exitCode: -1
                  });
                }
                reject(new McpError(
                  ErrorCode.InternalError,
                  timeoutMessage
                ));
              }, this.config.security.commandTimeout * 1000);

              shellProcess.on('close', () => clearTimeout(timeout));
            });
          }

          case "get_command_history": {
            if (!this.config.security.logCommands) {
              return {
                content: [{
                  type: "text",
                  text: "Command history is disabled in configuration. Consult the server admin for configuration changes (config.json - logCommands)."
                }]
              };
            }

            const args = z.object({
              limit: z.number()
                .min(1)
                .max(this.config.security.maxHistorySize)
                .optional()
                .default(10)
            }).parse(request.params.arguments);

            const history = this.commandHistory
              .slice(-args.limit)
              .map(entry => ({
                ...entry,
                output: entry.output.slice(0, 1000) // Limit output size
              }));

            return {
              content: [{
                type: "text",
                text: JSON.stringify(history, null, 2)
              }]
            };
          }

          case "ssh_execute": {
            if (!this.config.ssh.enabled) {
              throw new McpError(
                ErrorCode.InvalidRequest,
                "SSH support is disabled in configuration"
              );
            }

            const args = z.object({
              connectionId: z.string(),
              command: z.string()
            }).parse(request.params.arguments);

            const connectionConfig = this.config.ssh.connections[args.connectionId];
            if (!connectionConfig) {
              throw new McpError(
                ErrorCode.InvalidRequest,
                `Unknown SSH connection ID: ${args.connectionId}`
              );
            }

            try {
              // Validate command
              this.validateCommand('cmd', args.command);

              const connection = await this.sshPool.getConnection(args.connectionId, connectionConfig);
              const { output, exitCode } = await connection.executeCommand(args.command);

              // Store in history if enabled
              if (this.config.security.logCommands) {
                this.commandHistory.push({
                  command: args.command,
                  output,
                  timestamp: new Date().toISOString(),
                  exitCode,
                  connectionId: args.connectionId
                });

                if (this.commandHistory.length > this.config.security.maxHistorySize) {
                  this.commandHistory = this.commandHistory.slice(-this.config.security.maxHistorySize);
                }
              }

              return {
                content: [{
                  type: "text",
                  text: output || 'Command completed successfully (no output)'
                }],
                isError: exitCode !== 0,
                metadata: {
                  exitCode,
                  connectionId: args.connectionId
                }
              };
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              if (this.config.security.logCommands) {
                this.commandHistory.push({
                  command: args.command,
                  output: `SSH error: ${errorMessage}`,
                  timestamp: new Date().toISOString(),
                  exitCode: -1,
                  connectionId: args.connectionId
                });
              }
              throw new McpError(
                ErrorCode.InternalError,
                `SSH error: ${errorMessage}`
              );
            }
          }

          case "ssh_disconnect": {
            if (!this.config.ssh.enabled) {
              throw new McpError(
                ErrorCode.InvalidRequest,
                "SSH support is disabled in configuration"
              );
            }

            const args = z.object({
              connectionId: z.string()
            }).parse(request.params.arguments);

            await this.sshPool.closeConnection(args.connectionId);
            return {
              content: [{
                type: "text",
                text: `Disconnected from ${args.connectionId}`
              }]
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments: ${error.errors.map(e => e.message).join(', ')}`
          );
        }
        throw error;
      }
    });
  }

  private async cleanup(): Promise<void> {
    this.sshPool.closeAll();
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    
    // Set up cleanup handler
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
    
    await this.server.connect(transport);
    console.error("Windows CLI MCP Server running on stdio");
  }
}

// Start server
const main = async () => {
  try {
    const args = await parseArgs();
    
    // Handle --init-config flag
    if (args['init-config']) {
      try {
        createDefaultConfig(args['init-config'] as string);
        console.error(`Created default config at: ${args['init-config']}`);
        process.exit(0);
      } catch (error) {
        console.error('Failed to create config file:', error);
        process.exit(1);
      }
    }

    // Load configuration
    const config = loadConfig(args.config);
    
    const server = new CLIServer(config);
    await server.run();
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
};

main();