import parseDot = require('dotparser');
import { ChildProcess, spawn } from 'child_process';
import { resolve } from 'path';
import { createInterface, ReadLine } from 'readline';
import * as vscode from "vscode";
import * as logger from './logger';
import * as config from './config';
import * as testidutil from './testidutil';
import * as treebuilder from './test-tree-builder';
import * as model from './model';

const fs = require('fs');

interface TestSession {
    readonly stdout: ReadLine;
    readonly stderr: ReadLine;
    readonly stopped: Promise<number>;
    readonly process: ChildProcess;
}

export class TestExecutable {
    absPath: string;
    runningTests: TestSession[] = [];
    testItem: vscode.TestItem;

    private readonly regexEnterTestSuite = /^(.+): Entering test suite "(\w+)"$/;
    private readonly regexLeaveTestSuite = /^(.+): Leaving test suite "(\w+)"(?:; testing time: (\d+)(\w+))?$/;
    private readonly regexEnterTestCase = /^(.+): Entering test case "(\w+)"$/;
    private readonly regexLeaveTestCase = /^(.+): Leaving test case "(\w+)"(?:; testing time: (\d+)(\w+))?$/;
    private readonly regexTestCaseError = /^(.+)\(([0-9]+)\): error: in "([\w\/]+)": (.+)$/;
    private readonly regexTestCaseFatalError = /^(.+)\(([0-9]+)\): fatal error: in "([\w\/]+)": (.+)$/;

    constructor(
        readonly testExeTestItemId: string,
        readonly ctrl: vscode.TestController,
        readonly workspaceFolder: vscode.WorkspaceFolder,
        readonly cfg: config.TestExe,
        readonly log: logger.MyLogger) {
        this.absPath = resolve(this.workspaceFolder.uri.fsPath, this.cfg.path);

        this.testItem = this.ctrl.createTestItem(
            this.testExeTestItemId,
            `${this.getTestExeLabel()} (Open to load tests)`,
            vscode.Uri.file(this.absPath));
        // We load the tests from the test exe only when requested.
        this.testItem.canResolveChildren = true;
    }

    private getTestExeLabel(boostModuleName: string | undefined = undefined) {
        if (this.cfg.label) {
            return this.cfg.label;
        }
        if (boostModuleName) {
            return boostModuleName;
        }
        return this.cfg.path;
    }

    async loadTests(): Promise<void> {
        this.testItem.busy = true;
        const ok = await this.doLoadTests();
        if (!ok) {
            this.testItem.label = `${this.getTestExeLabel()} (Failed to load tests)`;
            this.testItem.children.replace([]);
            this.testItem.canResolveChildren = true;
        }
        this.testItem.busy = false;
    }

    private async doLoadTests(): Promise<boolean> {
        this.log.info(`Loading tests from ${this.cfg.path}`);

        // gather all output
        const session = await this.run(['--color_output=no', '--list_content=DOT']);
        let output = '';
        let exit: number;

        session.stderr.on('line', line => output += line);

        try {
            exit = await session.stopped;
        } catch (e) {
            this.log.error(`Cannot execute ${this.absPath} (cwd is ${this.cfg.cwd}).`);
            return false;
        }

        if (exit !== 0) {
            this.log.error(`${this.cfg.path} exited with code ${exit}`);
            return false;
        }

        // parse the output
        const graphs = parseDot(output);
        if (graphs.length === 0) {
            this.log.error(`Failed to parse list of test cases from ${this.cfg.path}`);
            return false;
        }

        // extract test module information
        let loadedTestItem: vscode.TestItem;
        try {
            loadedTestItem = treebuilder.createTestExeTestItem(
                this.absPath,
                this.testExeTestItemId,
                this.cfg.sourcePrefix,
                graphs,
                this.ctrl);
        } catch (e) {
            this.log.exception(e);
            return false;
        }
        const children: vscode.TestItem[] = [];
        loadedTestItem.children.forEach((item, _) => {
            children.push(item);
        });
        this.testItem.label = this.getTestExeLabel(loadedTestItem.label);
        this.testItem.children.replace(children);
        this.testItem.canResolveChildren = false;

        return true;
    }

    getTestItem(): vscode.TestItem {
        return this.testItem;
    }

    async runTests(
        testRun: vscode.TestRun,
        testItems: model.TestItem[]): Promise<void> {

        if (this.runningTests.length > 0) {
            this.log.warn(`Some tests are still running from ${this.cfg.path}`, true);
            return;
        }

        if (testItems.length === 0) {
            this.log.warn(`No test IDs were provided. Not running anything from ${this.cfg.path}`);
            return;
        }

        let session: TestSession;
        let errors: vscode.TestMessage[] = [];
        let isInsideTestCase = false;
        let isParsingError = false;

        // spawn the test process
        const boostTestIds = testidutil.createBoostTestIdsFrom(testItems);
        const args = [
            '-l', 'test_suite',
            '--catch_system_errors=yes',
            '--detect_memory_leaks=0',
            '--color_output=no'];
        if (boostTestIds.length > 0) {
            this.log.info(`Running the following tests from ${this.cfg.path}:`);
            for (const boostTestId of boostTestIds) {
                this.log.info(boostTestId);
            }
            session = await this.run(args.concat(['-t', boostTestIds.join(':')]));
        } else {
            // If there are no valid boost test IDs then we run all the tests.
            this.log.info(`Running all tests from ${this.cfg.path}`);
            session = await this.run(args);
        }

        // Tracks the current test ID based on the stdout output.
        let currentTestIdParts = [this.testExeTestItemId];

        this.log.info("----------------------------------------");

        const maxStdErrLines = 100;
        const stdError: string[] = [];
        session.stderr.on('line', line => {
            if (stdError.length < maxStdErrLines) {
                stdError.push(line);
            }
        });

        const lastItem = (arr: string[]) => arr[arr.length - 1];

        const reportProgress = (testIdParts: string[], reporter: (testItem: vscode.TestItem) => void) => {
            const testItemId = testidutil.createTestIdFromParts(testIdParts);
            const testItem = this.lookupTestItemById(testItemId);
            if (!testItem) {
                this.log.bug(`Cannot find TestItem with ID ${testItemId}`);
            } else {
                reporter(testItem);
            }
        };

        const enterTestCase = (testCaseName: string) => {
            currentTestIdParts.push(testCaseName);
            reportProgress(currentTestIdParts, (testItem) => {
                testRun.started(testItem);
            });
            isInsideTestCase = true;
        };

        // If "force" is true we "force-leave" the test-case.
        // This is needed if a test-case never "leaves" (for whatever unknown reason).
        const leaveTestCase = (force: boolean) => {
            reportProgress(currentTestIdParts, (testItem) => {
                if (force) {
                    testRun.errored(testItem, errors);
                } else if (errors.length === 0) {
                    testRun.passed(testItem);
                } else {
                    testRun.failed(testItem, errors);
                }
            });
            currentTestIdParts.pop();
            errors = [];
            isInsideTestCase = false;
        };

        const handleErrorMatch = (m: RegExpMatchArray) => {
            const msg = new vscode.TestMessage(m[4]);
            const file = m[1];
            if (file !== 'unknown location') {
                const lineStr = m[2];
                const lineNum = Math.max(0, Number(lineStr) - 1);
                const uri = vscode.Uri.file(file);
                const pos = new vscode.Position(lineNum, 0);
                msg.location = new vscode.Location(uri, pos);
            }
            errors.push(msg);
        }

        session.stdout.on('line', line => {
            let match: RegExpMatchArray | null;
            this.log.test(line);
            testRun.appendOutput(line + "\r\n");

            if (isParsingError) {
                // The parser got messed up.
                return;
            }

            // test case start
            match = this.regexEnterTestCase.exec(line);
            if (match) {
                if (isInsideTestCase) {
                    leaveTestCase(true);
                }
                enterTestCase(match[2]);
                return;
            }

            // test case end
            match = this.regexLeaveTestCase.exec(line);
            if (match) {
                if (lastItem(currentTestIdParts) !== match[2]) {
                    this.log.bug(`Parsing error: '${lastItem(currentTestIdParts)}' != '${match[2]}'`);
                    isParsingError = true;
                }
                leaveTestCase(false);
                return;
            }

            // test case error
            match = this.regexTestCaseError.exec(line);
            if (match) {
                if (isInsideTestCase) {
                    handleErrorMatch(match);
                } else {
                    this.log.bug(`We are in '${lastItem(currentTestIdParts)}'. This is not a test-case.`);
                }
                return;
            }

            // test case fatal error
            match = this.regexTestCaseFatalError.exec(line);
            if (match) {
                if (isInsideTestCase) {
                    handleErrorMatch(match);
                } else {
                    this.log.bug(`We are in '${lastItem(currentTestIdParts)}'. This is not a test-case.`);
                }
                return;
            }

            // test suite start
            match = this.regexEnterTestSuite.exec(line);
            if (match) {
                if (isInsideTestCase) {
                    leaveTestCase(true);
                }
                currentTestIdParts.push(match[2]);
                reportProgress(currentTestIdParts, (testItem) => {
                    testRun.started(testItem);
                });
                return;
            }

            // test suite end
            match = this.regexLeaveTestSuite.exec(line);
            if (match) {
                if (isInsideTestCase) {
                    leaveTestCase(true);
                }
                if (lastItem(currentTestIdParts) !== match[2]) {
                    this.log.bug(`Parsing error: '${lastItem(currentTestIdParts)}' != '${match[2]}'`);
                    isParsingError = true;
                }
                reportProgress(currentTestIdParts, (testItem) => {
                    testRun.passed(testItem);
                });
                currentTestIdParts.pop();
                return;
            }
        });

        this.runningTests.push(session);

        // wait for process to exit
        const code = await session.stopped;
        this.log.info(`${this.cfg.path} exited with code ${code}`);
        if (code !== 0) {
            this.log.error(`${this.cfg.path} exited with code ${code}`, true);
            if (stdError.length > 0) {
                this.log.error(`First ${maxStdErrLines} lines of stderr:`);
                for (const err of stdError) {
                    this.log.error(err);
                }
            }
        }

        this.runningTests = this.runningTests.filter(s => s !== session);

        return;
    }

    cancelTests(log: logger.MyLogger) {
        if (this.runningTests.length === 0) {
            return;
        }
        log.info(`Cancelling running tests of ${this.cfg.path}`);
        for (const session of this.runningTests) {
            session.process.kill();
        }
    }

    async debugTests(testItems: model.TestItem[], log: logger.MyLogger): Promise<void> {
        if (typeof this.cfg.debugConfig !== 'string') {
            log.error(`Settings: debugConfig is not set for ${this.cfg.path}`, true);
            return;
        }

        let args = ['-l', 'all', '--catch_system_errors=no', '--detect_memory_leaks=0'];
        const boostTestIds = testidutil.createBoostTestIdsFrom(testItems);
        // If there are no valid boost test IDs then we run all the tests.
        if (boostTestIds.length > 0) {
            args = args.concat(['-t', boostTestIds.join(':')]);
            log.info(`Debugging the following tests from ${this.cfg.path}:`);
            for (const boostTestId of boostTestIds) {
                log.info(boostTestId);
            }
        } else {
            log.info(`Debugging all tests from ${this.cfg.path}`);
        }

        const config = vscode.workspace.getConfiguration(
            'launch',
            this.workspaceFolder.uri
        );
        const configs = config.get<vscode.DebugConfiguration[]>('configurations');
        if (!configs) {
            log.error(`Cannot find any launch configurations. Please create one with the name '${this.cfg.debugConfig}'.`, true);
            return;
        }
        let debugConfiguration = configs.find(cfg => cfg.name === this.cfg.debugConfig);
        if (!debugConfiguration) {
            log.error(`Cannot find launch configuration '${this.cfg.debugConfig}' for ${this.cfg.path}.`, true);
            return;
        }

        debugConfiguration["program"] = this.absPath;
        debugConfiguration["args"] = args;
        debugConfiguration["outputCapture"] = "std";
        const envMap = await this.createFinalEnvMap();
        if (envMap !== undefined) {
            debugConfiguration["environment"] = createEnvForDebug(envMap);
        }

        await vscode.debug.startDebugging(undefined, debugConfiguration);
    }

    private async run(args: string[]): Promise<TestSession> {
        const options: Record<string, any> = {
            cwd: this.cfg.cwd
        };
        const envMap = await this.createFinalEnvMap();
        if (envMap !== undefined) {
            options.env = createEnvForSpawn(envMap);
        }
        const process = spawn(this.absPath, args, options);
        let stdout: ReadLine | undefined;
        let stderr: ReadLine | undefined;

        try {
            const stopped = new Promise<number>((resolve, reject) => {
                process.on('error', reject);
                process.on('close', resolve);
            });

            stdout = createInterface({ input: process.stdout! });
            stderr = createInterface({ input: process.stderr! });

            return { stdout, stderr, stopped, process };
        } catch (e) {
            stdout?.close();
            stderr?.close();
            process.kill();
            throw e;
        }
    }

    private lookupTestItemById(testItemId: string): vscode.TestItem | undefined {
        if (!this.testItem) {
            this.log.bug(`Tests are not loaded yet for ${this.cfg.path}`);
            return undefined;
        }
        // First find the root of the tree.
        let root: vscode.TestItem = this.testItem;
        while (root.parent) {
            root = root.parent;
        }
        // Then look for the item starting from the root.
        const idParts = testidutil.getTestIdParts(testItemId);
        let item: vscode.TestItem | undefined = root;
        for (let level = 1; item && item.id !== testItemId; ++level) {
            const nextTestItemId = testidutil.createChildTestId(item.id, idParts[level]);
            item = item.children.get(nextTestItemId);
        }
        return item;
    }

    private async createFinalEnvMap(): Promise<Map<string, string> | undefined> {
        let map: Map<string, string> | undefined;
        if (this.cfg.envFile !== undefined) {
            map = await parseEnvFile(this.cfg.envFile, this.log);
        }
        if (this.cfg.env !== undefined) {
            if (map !== undefined) {
                for (const [name, val] of this.cfg.env) {
                    map.set(name, val);
                }
            } else {
                map = this.cfg.env;
            }
        }
        return map;
    }

}

async function parseEnvFile(
    filePath: string,
    log: logger.MyLogger): Promise<Map<string, string>> {
    let envMap = new Map<string, string>();
    try {
        const contents: string = await fs.promises.readFile(filePath, 'utf-8');
        contents.split(/\r?\n/).forEach((line) => {
            const trimmedLine = line.trim();
            if (trimmedLine.length > 0) {
                const eqPos = trimmedLine.indexOf('=');
                if (eqPos !== -1) {
                    const name = trimmedLine.substring(0, eqPos);
                    const value = trimmedLine.substring(eqPos + 1);
                    envMap.set(name, value);
                } else {
                    log.warn(`Settings: Bad line in envFile: '${trimmedLine}'`);
                }
            }
        });
    } catch (e) {
        log.exception(e);
    }
    return envMap;
}

function createEnvForDebug(envMap: Map<string, string>): { name: string, value: string }[] {
    let env: { name: string, value: string }[] = [];
    for (const [n, v] of envMap) {
        env.push({ name: n, value: v });
    }
    return env;
}

function createEnvForSpawn(envMap: Map<string, string>): Record<string, string> {
    // spawn() needs env as a plain object of (key, value) pairs.
    let env: Record<string, string> = {};
    for (const [n, v] of envMap) {
        env[n] = v;
    }
    return env;
}
