import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
/** The acceptance fixture acts as an install record only for the actual first-party source checkout. */
function verifiedPluginSource(root, plugin) {
 const source=execFileSync('git',['-C',root,'remote','get-url','origin'],{encoding:'utf8'}).trim();
 const canonical=`https://github.com/BIackFIame/canvastty-plugin-${plugin}.git`;
 assert.equal(source.replace(/\.git$/i,'').toLowerCase(),canonical.replace(/\.git$/i,'').toLowerCase(),'plugin fixture must have verified repository provenance');
 return canonical;
}

export const verifiedEnvironmentPluginSource = root => verifiedPluginSource(root, "environments");
export const verifiedAccountsPluginSource = root => verifiedPluginSource(root, "accounts");
