import * as path from "path";
import * as _ from "lodash";
import defaults from "./defaults";
import { BrowserConfig } from "./browser-config";
import parseOptions from "./options";
import logger from "../utils/logger";
import { ConfigInput } from "./types";

export class Config {
    configPath!: string;

    static create(config?: string | ConfigInput): Config {
        return new Config(config);
    }

    static read(configPath: string): unknown {
        try {
            return require(path.resolve(process.cwd(), configPath));
        } catch (e) {
            logger.error(`Unable to read config from path ${configPath}`);
            throw e;
        }
    }

    constructor(config?: string | ConfigInput) {
        let options: ConfigInput;
        if (_.isObjectLike(config)) {
            options = config as ConfigInput;
        } else if (typeof config === "string") {
            this.configPath = config;
            options = Config.read(config) as ConfigInput;
        } else {
            for (const configPath of defaults.configPaths) {
                try {
                    const resolvedConfigPath = path.resolve(configPath);
                    require(resolvedConfigPath);
                    this.configPath = resolvedConfigPath;

                    break;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } catch (err: any) {
                    if (err.code !== "MODULE_NOT_FOUND") {
                        throw err;
                    }
                }
            }

            if (!this.configPath) {
                throw new Error(`Unable to read config from paths: ${defaults.configPaths.join(", ")}`);
            }

            options = Config.read(this.configPath) as ConfigInput;
        }

        if (_.isFunction(options.prepareEnvironment)) {
            options.prepareEnvironment();
        }

        _.extend(
            this,
            parseOptions({
                options,
                env: process.env,
                argv: process.argv,
            }),
        );

        this.browsers = _.mapValues(this.browsers, (browser, id) => {
            const browserOptions = _.extend({}, browser, {
                id: id,
                system: this.system,
            });

            return new BrowserConfig(browserOptions);
        });
    }

    forBrowser(id: string): BrowserConfig {
        return this.browsers[id];
    }

    getBrowserIds(): Array<string> {
        return _.keys(this.browsers);
    }

    serialize(): Omit<Config, "system"> {
        return _.extend({}, this, {
            browsers: _.mapValues(this.browsers, broConf => broConf.serialize()),
        });
    }

    /**
     * This method is used in subrocesses to merge a created config
     * in a subrocess with a config from the main process
     */
    mergeWith(config: Config): void {
        _.mergeWith(this, config, (l, r) => {
            if (_.isObjectLike(l)) {
                return;
            }

            // When passing stringified config from the master to workers
            // all functions are transformed to strings and all regular expressions to empty objects
            return typeof l === typeof r ? r : l;
        });
    }
}
