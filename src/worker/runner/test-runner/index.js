/* global document */
"use strict";

const _ = require("lodash");
const HookRunner = require("./hook-runner");
const ExecutionThread = require("./execution-thread");
const OneTimeScreenshooter = require("./one-time-screenshooter");
const { AssertViewError } = require("../../../browser/commands/assert-view/errors/assert-view-error");
const history = require("../../../browser/history");
const { SAVE_HISTORY_MODE } = require("../../../constants/config");

module.exports = class TestRunner {
    static create(...args) {
        return new this(...args);
    }

    constructor(test, config, browserAgent) {
        this._test = test.clone();
        this._test.hermioneCtx = _.cloneDeep(test.hermioneCtx);

        this._config = config;
        this._browserAgent = browserAgent;
    }

    async run({ sessionId, sessionCaps, sessionOpts, state }) {
        const test = this._test;
        const hermioneCtx = test.hermioneCtx || {};

        let browser;

        try {
            browser = await this._browserAgent.getBrowser({ sessionId, sessionCaps, sessionOpts, state });
        } catch (e) {
            throw Object.assign(e, { hermioneCtx });
        }

        const screenshooter = OneTimeScreenshooter.create(this._config, browser);
        const executionThread = ExecutionThread.create({ test, browser, hermioneCtx, screenshooter });
        const hookRunner = HookRunner.create(test, executionThread);
        const { callstackHistory } = browser;

        let error;

        try {
            const { resetCursor } = browser.config;
            const shouldRunBeforeEach = resetCursor || hookRunner.hasBeforeEachHooks();

            if (shouldRunBeforeEach) {
                await history.runGroup(callstackHistory, "beforeEach", async () => {
                    if (resetCursor) {
                        // TODO: make it on browser.init when "actions" method will be implemented in all webdrivers
                        await history.runGroup(callstackHistory, "resetCursor", () =>
                            this._resetCursorPosition(browser),
                        );
                    }

                    await hookRunner.runBeforeEachHooks();
                });
            }

            await executionThread.run(test);
        } catch (e) {
            error = e;
        }

        if (isSessionBroken(error, this._config)) {
            browser.markAsBroken();
        }

        try {
            const needsAfterEach = hookRunner.hasAfterEachHooks();

            if (needsAfterEach) {
                await history.runGroup(callstackHistory, "afterEach", () => hookRunner.runAfterEachHooks());
            }
        } catch (e) {
            error = error || e;
        }

        const assertViewResults = hermioneCtx.assertViewResults;
        if (!error && assertViewResults && assertViewResults.hasFails()) {
            error = new AssertViewError();

            if (screenshooter.getScreenshot()) {
                error.screenshot = screenshooter.getScreenshot();
            }
        }

        // we need to check session twice:
        // 1. before afterEach hook to prevent work with broken sessions
        // 2. after collecting all assertView errors (including afterEach section)
        if (!browser.state.isBroken && isSessionBroken(error, this._config)) {
            browser.markAsBroken();
        }

        hermioneCtx.assertViewResults = assertViewResults ? assertViewResults.toRawObject() : [];
        const { meta } = browser;
        const commandsHistory = callstackHistory ? callstackHistory.release() : [];
        const results = {
            hermioneCtx,
            meta,
        };

        switch (browser.config.saveHistoryMode) {
            case SAVE_HISTORY_MODE.ALL:
            case error && SAVE_HISTORY_MODE.ONLY_FAILED:
                results.history = commandsHistory;
                break;
        }

        this._browserAgent.freeBrowser(browser);

        if (error) {
            throw Object.assign(error, results);
        }

        return results;
    }

    async _resetCursorPosition({ publicAPI: session }) {
        const body = await session.$("body");
        if (!body) {
            throw new Error('There is no "body" element on the page when resetting cursor position');
        }

        await body.scrollIntoView();

        const { x = 0, y = 0 } = await session.execute(function () {
            return document.body.getBoundingClientRect();
        });
        // x and y must be integer, wdio will throw error otherwise
        await body.moveTo({ xOffset: -Math.floor(x), yOffset: -Math.floor(y) });
    }
};

function isSessionBroken(error, { system: { patternsOnReject } }) {
    return error && patternsOnReject.some(p => new RegExp(p).test(error.message));
}
