'use strict';

/**
 * Command Roster Module
 *
 * Read-only helper for discovering canonical commands/ferrox command stems and
 * applying the shared Ferrox slash-command namespace transform.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const slashCommandTransformer = require('../../../scripts/fix-slash-commands.cjs') as {
  readCmdNames: () => string[];
  transformContentToHyphen: (src: string, cmdNames: string[]) => string;
  transformContent: (src: string, cmdNames: string[]) => string;
  buildPattern: (cmdNames: string[]) => RegExp | null;
  buildColonPattern: (cmdNames: string[]) => RegExp | null;
};

function readFerroxCommandNames(): string[] {
  return slashCommandTransformer.readCmdNames();
}

export = {
  readFerroxCommandNames,
  transformContentToHyphen: slashCommandTransformer.transformContentToHyphen,
  transformContent: slashCommandTransformer.transformContent,
  buildPattern: slashCommandTransformer.buildPattern,
  buildColonPattern: slashCommandTransformer.buildColonPattern,
};
