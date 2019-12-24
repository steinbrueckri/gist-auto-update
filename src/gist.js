import Octokit from '@octokit/rest';
import debug from './debug';

const log = debug('gist');

class Gist {

  /**
   *
   * @param {string} ghToken
   */
  constructor(ghToken) {
    this.octokit = new Octokit({ auth: `token ${ghToken}` });
    log('authenticate with token %o', ghToken.slice(0, 3) + '...');
  }

  /**
   *
   * @param {object} configs
   * @param {string} configs.gistId
   * @param {string} configs.newDescription
   * @param {GistFile[]} configs.newFiles
   * @returns {Promise<number>} Resolves to status code.
   */
  async updateGistById({ gistId, newDescription, newFiles }) {
    log('will get gist with id %o', gistId);
    const gistResponse = await this.octokit.gists.get({ gist_id: gistId });
    log('get done');

    const gistOldFilenames = Object.keys(gistResponse.data.files);
    const filesToDelete = gistOldFilenames.map(oldFilename => [oldFilename, null]);

    const files = newFiles.reduce((gistFiles, currGistFile) => {
      gistFiles[currGistFile.filename] = {
        content: currGistFile.content,
      };
      return gistFiles;
    // @ts-ignore
    }, Object.fromEntries(filesToDelete));

    log('will update gist with id %o', gistId);

    const updatedGistResponse = await this.octokit.gists.update({
      description: newDescription,
      gist_id: gistId,
      files,
    });

    log('update done');

    return updatedGistResponse.status;
  }

}

export default Gist;