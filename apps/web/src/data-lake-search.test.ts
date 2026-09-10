import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDataLakeSearchUrl,
  formatCustomFieldBadges,
  parseCustomFieldExistsText,
  parseCustomFieldInput,
  parseCustomFieldFilterText
} from "./data-lake-search.js";

test("parseCustomFieldFilterText parses comma and newline separated key value filters", () => {
  assert.deepEqual(
    parseCustomFieldFilterText("project=ospx-ff, section=requirements\npriority=P0"),
    {
      project: "ospx-ff",
      section: "requirements",
      priority: "P0"
    }
  );
});

test("parseCustomFieldFilterText parses JSON object custom fields", () => {
  assert.deepEqual(
    parseCustomFieldFilterText('{"project":"ospx-ff","priority":0,"reviewed":true,"empty":null}'),
    {
      project: "ospx-ff",
      priority: 0,
      reviewed: true,
      empty: null
    }
  );
});

test("buildDataLakeSearchUrl encodes source and custom field filters", () => {
  assert.equal(
    buildDataLakeSearchUrl({
      q: "数据湖",
      sourceApp: "notion",
      sourceType: "document",
      customFields: {
        project: "ospx-ff",
        section: "requirements",
        reviewed: true
      }
    }),
    "/context/search-data-lake?q=%E6%95%B0%E6%8D%AE%E6%B9%96&sourceApp=notion&sourceType=document&custom.project=ospx-ff&custom.section=requirements&custom.reviewed=true"
  );
});

test("buildDataLakeSearchUrl encodes existence and nested custom field filters", () => {
  assert.equal(
    buildDataLakeSearchUrl({
      customFields: {
        task: {
          id: "task-1"
        }
      },
      customFieldExists: ["project", "task.owner"]
    }),
    "/context/search-data-lake?custom.project.__exists=true&custom.task.id=task-1&custom.task.owner.__exists=true"
  );
});

test("buildDataLakeSearchUrl treats wildcard as an ordinary custom field value", () => {
  assert.equal(
    buildDataLakeSearchUrl({
      customFields: {
        marker: "*"
      }
    }),
    "/context/search-data-lake?custom.marker=*"
  );
});

test("buildDataLakeSearchUrl treats __exists as an ordinary custom field value", () => {
  assert.equal(
    buildDataLakeSearchUrl({
      customFields: {
        marker: "__exists"
      }
    }),
    "/context/search-data-lake?custom.marker=__exists"
  );
});

test("formatCustomFieldBadges keeps primitive custom fields readable", () => {
  assert.deepEqual(
    formatCustomFieldBadges({
      project: "ospx-ff",
      priority: 0,
      reviewed: true,
      empty: null
    }),
    ["project=ospx-ff", "priority=0", "reviewed=true", "empty=null"]
  );
});

test("parseCustomFieldFilterText ignores malformed entries", () => {
  assert.deepEqual(parseCustomFieldFilterText("project=ospx-ff, invalid, =skip, section=requirements"), {
    project: "ospx-ff",
    section: "requirements"
  });
});

test("parseCustomFieldExistsText parses comma and newline separated paths", () => {
  assert.deepEqual(parseCustomFieldExistsText("project, task.owner\nmetadata.source"), ["project", "task.owner", "metadata.source"]);
});

test("parseCustomFieldInput rejects non-empty text without valid fields", () => {
  assert.deepEqual(parseCustomFieldInput("随便写什么"), {
    ok: false,
    error: "自定义字段必须是 JSON 对象，或 key=value 列表。"
  });
});
