// @ts-check
/// <reference path="../globals.d.ts" />
const axios = require('axios').default;
const AxiosLogger = require('axios-logger');
const uuid = require('uuid');

// @ts-ignore
Array.prototype.flat = require('array.prototype.flat').getPolyfill();

/** @type {ROOT_SECTION} */
const ROOT_SECTION = ':root';

const RE_PLAYLIST_CONTENT = /\bplaylist\b/;
const RE_YT_PLAYLIST = /\s*-\s*YouTube$/;
const RE_TAG = /^\{([^}]+)\}\s+(.+)/;
const RE_HYPERTEXT_1 = /^([^\(\s]+)\s+(?:\s*\((.+)\))\B/;
const RE_HYPERTEXT_2 = /^\[([^\(\s]+)\](?:\s*\((.+)\))\B/;
const RE_IGNORE_ITEM = /\u2716:?$/;// https://apps.timwhitlock.info/unicode/inspect/hex/2716
const RE_IGNORE_SECTION = /\u2716$/;
const RE_CATEGORY_ITEM = /:$/;
const NIL = -1;

/**
 *
 * @param {object} obj
 * @returns {object}
 */
function onlyTruthyValuesOnPojo(obj) {
  const newObj = Object.keys(obj).reduce((newObj, prop) => {
    if (obj[prop]) {
      newObj[prop] = obj[prop];
    }
    return newObj;
  }, {});

  return newObj;
}

/**
 *
 * @param {string} dateStr
 * @returns {string}
 */
function formatDate(dateStr) {
  if (typeof dateStr !== 'string') {
    throw TypeError(`dateStr is not a string (${typeof dateStr})`);
  }

  const [, day, month, year] = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return `${month} ${day}, ${year}`;
}

/**
 *
 * @param {string} str
 * @returns {string}
 */
const removeYouTubeKeyword = (str) => str.replace(RE_YT_PLAYLIST, '');

/**
 *
 * @param {string} content
 * @returns {TaskContent}
 */
function formatContent(content) {
  if (typeof content !== 'string') {
    throw TypeError(`content is not a string (${typeof content})`);
  }

  const parsedContent = {
    text: undefined,
    tag: undefined,
    link: undefined,
  };

  const matchesTag = content.match(RE_TAG);
  if (matchesTag) {
    [, parsedContent.tag, content] = matchesTag;
  } else {
    if (RE_PLAYLIST_CONTENT.test(content)) {
      parsedContent.tag = 'playlist';
    }
  }

  // Now `content` do not have a tag on it
  const matchesHypertext1 = content.match(RE_HYPERTEXT_1);
  if (matchesHypertext1) {
    [, parsedContent.link, content] = matchesHypertext1;
  } else {
    const matchesHypertext2 = content.match(RE_HYPERTEXT_2);
    if (matchesHypertext2) {
      [, content, parsedContent.link] = matchesHypertext2;
    }
  }

  parsedContent.text = removeYouTubeKeyword(content);
  parsedContent.tag = parsedContent.tag && parsedContent.tag.toLowerCase();
  return onlyTruthyValuesOnPojo(parsedContent);
}

/**
 *
 * @param {TodoistSyncAPI.ProjectData} data
 * @param {SectionMap} sectionsNameById
 * @returns {[TodoistPartialResponse, number[]]}
 */
function mapProjectDataToItems(data, sectionsNameById) {
  const { project, items } = data;

  const [wellFormattedItems, categoryIds] = formatProjectItems(items, sectionsNameById);
  const [wellFormattedNoncheckedItems, wellFormattedCheckedItems] = wellFormattedItems.reduce((itemsPair, item) => {
    itemsPair[ +item.checked ].push(item);
    return itemsPair;
  }, [[], []]);

  return [
    {
      name: project.name,
      items: {
        done: wellFormattedCheckedItems,
        pending: wellFormattedNoncheckedItems,
      }
    },
    categoryIds,
  ];
}


/**
 *
 * @param {TodoistSyncAPI.Item[]} items
 * @param {SectionMap} [sectionsNameById]
 * @returns {[Task[], number[]]}
 */
function formatProjectItems(items, sectionsNameById = { null: ROOT_SECTION }) {
  /** @param {TodoistSyncAPI.Item} item */
  const formatItem = item => ({
    checked: !!item.checked,
    dateAdded: formatDate(item.date_added),
    id: item.id,
    parentId: item.parent_id,
    sectionId: item.section_id,
    priority: item.priority,
    content: formatContent(item.content),
  });

  const selectedTasks = [];
  const categoryIds = [];
  let lastSkippedParentId = NIL;

  for (const item of items) { // Filter and format items
    const {
      id: currId,
      parent_id: currParentId,
      content: currContent,
      section_id: sectionId,
    } = item;

    if (!(sectionId in sectionsNameById)) {
      continue;
    }

    if (RE_IGNORE_ITEM.test(currContent)) { // Skip this item and nested ones
      lastSkippedParentId = currId;
      continue;
    }

    const isCategory = RE_CATEGORY_ITEM.test(currContent);
    const parentSkipped = currParentId == lastSkippedParentId;
    const skipItem = (parentSkipped || isCategory);

    if (!skipItem) {
      selectedTasks.push(formatItem(item));
    }

    if (currParentId !== lastSkippedParentId) {
      lastSkippedParentId = NIL;
    }

    if (isCategory) {
      categoryIds.push(currId);
      if (parentSkipped) {
        lastSkippedParentId = currId;
      }
    }
  }

  return [
    selectedTasks,
    categoryIds,
  ];
}


class Todoist {

  constructor(apiToken) {
    this.conn = axios.create({
      baseURL: 'https://api.todoist.com/sync/v8',
      responseType: 'json',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'X-Request-Id': uuid(),
      },
    });

    this.conn.interceptors.request.use(AxiosLogger.requestLogger, AxiosLogger.errorLogger);
  }

  /**
   *
   * @param {number} [projectId]
   * @returns {Promise<TodoistSyncAPI.Section[]>}
   */
  async _getSections(projectId) {
    if (typeof projectId !== 'number') {
      throw TypeError(`The argument (projectId) must be a 'number' (${typeof projectId})`);
    }

    const { data } = await this.conn.post('sync', {
      sync_token: '*',
      resource_types: '["sections"]',
    });

    if (projectId) {
      return data.sections.filter(section => section.project_id === projectId);
    }

    return data.sections;
  };

  /**
   *
   * @param {number} projectId
   * @returns {Promise<TodoistSyncAPI.ProjectData>}
   */
  async _getProjectData(projectId) {
    if (typeof projectId !== 'number') {
      throw TypeError(`The argument (projectId) must be a 'number' (${typeof projectId})`);
    }

    const { data } = await this.conn.post('projects/get_data', {
      project_id: projectId.toString()
    });
    return data;
  };

  /**
   *
   * @param {string} paramKey
   * @param {string} paramValue
   * @returns {Promise<TodoistSyncAPI.ArchivedProjectData>}
   */
  async _getArchivedProjectItems(paramKey, paramValue) {
    if (typeof paramKey !== 'string' || !paramKey.trim()) {
      throw TypeError(`The first argument (paramKey) must be a 'string' (${typeof paramKey})`);
    }
    if (typeof paramValue !== 'string') {
      throw TypeError(`The second argument (paramValue) must be a 'string' (${typeof paramValue})`);
    }

    const params = { [paramKey]: paramValue };
    let { data } = await this.conn.post('archive/items', params);

    while (data.has_more) { // To fetch all pages
      Object.assign(params, {
        cursor: data.next_cursor
      });

      const {
        data: nextData
      } = await this.conn.post('archive/items', params);
      nextData.items = data.items.concat(nextData.items);
      data.next_cursor = nextData.next_cursor; // this could be `undefined`
      Object.assign(data, nextData);
    }

    return data;
  }


  /**
   *
   * @param {number} projectId
   * @returns {Promise<TodoistSyncAPI.ArchivedProjectData>}
   */
  async getArchivedProjectItemsUnderProject(projectId) {
    return this._getArchivedProjectItems('project_id', projectId.toString());
  }

  /**
   *
   * @param {number} parentId
   * @returns {Promise<TodoistSyncAPI.ArchivedProjectData>}
   */
  async getArchivedProjectItemsUnderParentItem(parentId) {
    return this._getArchivedProjectItems('parent_id', parentId.toString());
  }

  /**
   *
   * @param {number} sectionId
   * @returns {Promise<TodoistSyncAPI.ArchivedProjectData>}
   */
  async getArchivedProjectItemsUnderSection(sectionId) {
    return this._getArchivedProjectItems('section_id', sectionId.toString());
  }


  // /**
  //  * Async generator version of `getArchivedProjectItems` method.
  //  * @param {string} projectId
  //  * @param {string} [parentId]
  //  * @param {string} [cursor='']
  //  * @returns {AsyncGenerator<TodoistSyncAPI.ArchivedProjectData>}
  //  */
  // async * $getArchivedProjectItems(projectId, parentId, cursor = '') {
  //   const params = parentId
  //     ? { parent_id: parentId }
  //     : { project_id: projectId };
  //   Object.assign(params, { cursor });
  //   const { data } = await this.conn.post('archive/items', params);
  //   yield data;
  //   if (data.has_more) {
  //     yield* this.$getArchivedProjectItems(projectId, parentId, data.next_cursor);
  //   }
  // }

  /**
   *
   * @param {number} projectId
   * @returns {Promise<SectionMap>}
   */
  async getSectionsGroupedByProjectId(projectId) {
    const sections = await this._getSections(projectId);

    /** @type {SectionMap} */
    const sectionsNameById = sections.reduce((sectionsMap, section) => {
      if (!RE_IGNORE_SECTION.test(section.name.trim())) {
        sectionsMap[ section.id ] = formatContent(section.name);
      }
      return sectionsMap;
    }, {
      null: ROOT_SECTION,
    });

    return sectionsNameById;
  }

  /**
   *
   * @param {number} projectId
   * @param {SectionMap} [sectionsNameById]
   * @returns {Promise<[TodoistPartialResponse, number[]]>}
   */
  getWellFormattedProjectData(projectId, sectionsNameById) {
    return this._getProjectData(projectId)
      .then(data => mapProjectDataToItems(data, sectionsNameById));
  }

  /**
   *
   * @param {number} projectId
   * @param {SectionMap} [sectionsNameById]
   * @param {number[]} [parentIds]
   * @returns {Promise<Task[]>}
   */
  getProjectArchivedTasks(projectId, sectionsNameById, parentIds) {
    /**
     * @param {TodoistSyncAPI.ArchivedProjectData} data
     * @returns {Task[]}
     */
    const getTasksFromResponseData = data => formatProjectItems(data.items, sectionsNameById)[0];

    /**
     *
     * @param {Promise<TodoistSyncAPI.ArchivedProjectData>} whenData
     * @returns {Promise<Task[]>}
     */
    const getTasks = whenData => whenData.then(getTasksFromResponseData);

    const {null: _, ...projectSectionsNameById} = sectionsNameById;
    const sectionsIds = Object.keys(projectSectionsNameById).map(Number);

    const whenTasksByProjectId = getTasks( this.getArchivedProjectItemsUnderProject(projectId) );
    const whenTasksBySectionId = sectionsIds.map(sectionId =>
      getTasks( this.getArchivedProjectItemsUnderSection(sectionId) )
    );

    const whenAllKindTasks = [
      whenTasksByProjectId,
      whenTasksBySectionId,
    ].flat();

    if (parentIds && parentIds.length) {
      for (const parentId of parentIds) {
        const whenArchivedProjectTasks = getTasks( this.getArchivedProjectItemsUnderParentItem(parentId) );
        whenAllKindTasks.push(whenArchivedProjectTasks);
      }
    }

    return Promise.all(whenAllKindTasks)
      .then(fulfilledPromises => fulfilledPromises.flat());
  }

}

module.exports = Todoist;
