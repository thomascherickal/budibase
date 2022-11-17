const {
  generateDatasourceID,
  getDatasourceParams,
  getQueryParams,
  DocumentType,
  BudibaseInternalDB,
  getTableParams,
} = require("../../db/utils")
const { destroy: tableDestroy } = require("./table/internal")
const { BuildSchemaErrors, InvalidColumns } = require("../../constants")
const { getIntegration } = require("../../integrations")
const { getDatasourceAndQuery } = require("./row/utils")
const { invalidateDynamicVariables } = require("../../threads/utils")
const { getAppDB } = require("@budibase/backend-core/context")
const { events } = require("@budibase/backend-core")
const { BUDIBASE_DATASOURCE_TYPE } = require("@budibase/backend-core/constants")

exports.fetch = async function (ctx) {
  // Get internal tables
  const db = getAppDB()
  const internalTables = await db.allDocs(
    getTableParams(null, {
      include_docs: true,
    })
  )

  const internal = internalTables.rows.reduce((acc, row) => {
    const sourceId = row.doc.sourceId || "bb_internal"
    acc[sourceId] = acc[sourceId] || []
    acc[sourceId].push(row.doc)
    return acc
  }, {})

  const bbInternalDb = {
    ...BudibaseInternalDB,
  }

  // Get external datasources
  const datasources = (
    await db.allDocs(
      getDatasourceParams(null, {
        include_docs: true,
      })
    )
  ).rows.map(row => row.doc)

  const allDatasources = [bbInternalDb, ...datasources]

  for (let datasource of allDatasources) {
    if (datasource.config && datasource.config.auth) {
      // strip secrets from response so they don't show in the network request
      delete datasource.config.auth
    }

    if (datasource.type === BUDIBASE_DATASOURCE_TYPE) {
      datasource.entities = internal[datasource._id]
    }
  }

  ctx.body = [bbInternalDb, ...datasources]
}

exports.buildSchemaFromDb = async function (ctx) {
  const db = getAppDB()
  const datasource = await db.get(ctx.params.datasourceId)
  const tablesFilter = ctx.request.body.tablesFilter

  let { tables, error } = await buildSchemaHelper(datasource)
  if (tablesFilter) {
    if (!datasource.entities) {
      datasource.entities = {}
    }
    for (let key in tables) {
      if (
        tablesFilter.some(filter => filter.toLowerCase() === key.toLowerCase())
      ) {
        datasource.entities[key] = tables[key]
      }
    }
  } else {
    datasource.entities = tables
  }

  setDefaultDisplayColumns(datasource)
  const dbResp = await db.put(datasource)
  datasource._rev = dbResp.rev

  const response = { datasource }
  if (error) {
    response.error = error
  }
  ctx.body = response
}

/**
 * Make sure all datasource entities have a display name selected
 */
const setDefaultDisplayColumns = datasource => {
  //
  for (let entity of Object.values(datasource.entities)) {
    if (entity.primaryDisplay) {
      continue
    }
    const notAutoColumn = Object.values(entity.schema).find(
      schema => !schema.autocolumn
    )
    if (notAutoColumn) {
      entity.primaryDisplay = notAutoColumn.name
    }
  }
}

/**
 * Check for variables that have been updated or removed and invalidate them.
 */
const invalidateVariables = async (existingDatasource, updatedDatasource) => {
  const existingVariables = existingDatasource.config.dynamicVariables
  const updatedVariables = updatedDatasource.config.dynamicVariables
  const toInvalidate = []

  if (!existingVariables) {
    return
  }

  if (!updatedVariables) {
    // invalidate all
    toInvalidate.push(...existingVariables)
  } else {
    // invaldate changed / removed
    existingVariables.forEach(existing => {
      const unchanged = updatedVariables.find(
        updated =>
          existing.name === updated.name &&
          existing.queryId === updated.queryId &&
          existing.value === updated.value
      )
      if (!unchanged) {
        toInvalidate.push(existing)
      }
    })
  }
  await invalidateDynamicVariables(toInvalidate)
}

exports.update = async function (ctx) {
  const db = getAppDB()
  const datasourceId = ctx.params.datasourceId
  let datasource = await db.get(datasourceId)
  const auth = datasource.config.auth
  await invalidateVariables(datasource, ctx.request.body)
  datasource = { ...datasource, ...ctx.request.body }
  if (auth && !ctx.request.body.auth) {
    // don't strip auth config from DB
    datasource.config.auth = auth
  }

  const response = await db.put(datasource)
  await events.datasource.updated(datasource)
  datasource._rev = response.rev

  // Drain connection pools when configuration is changed
  if (datasource.source) {
    const source = await getIntegration(datasource.source)
    if (source && source.pool) {
      await source.pool.end()
    }
  }

  ctx.status = 200
  ctx.message = "Datasource saved successfully."
  ctx.body = { datasource }
}

exports.save = async function (ctx) {
  const db = getAppDB()
  const plus = ctx.request.body.datasource.plus
  const fetchSchema = ctx.request.body.fetchSchema

  const datasource = {
    _id: generateDatasourceID({ plus }),
    type: plus ? DocumentType.DATASOURCE_PLUS : DocumentType.DATASOURCE,
    ...ctx.request.body.datasource,
  }

  let schemaError = null
  if (fetchSchema) {
    const { tables, error } = await buildSchemaHelper(datasource)
    schemaError = error
    datasource.entities = tables
    setDefaultDisplayColumns(datasource)
  }

  const dbResp = await db.put(datasource)
  await events.datasource.created(datasource)
  datasource._rev = dbResp.rev

  // Drain connection pools when configuration is changed
  if (datasource.source) {
    const source = await getIntegration(datasource.source)
    if (source && source.pool) {
      await source.pool.end()
    }
  }

  const response = { datasource }
  if (schemaError) {
    response.error = schemaError
  }
  ctx.body = response
}

const destroyInternalTablesBySourceId = async datasourceId => {
  const db = getAppDB()

  // Get all internal tables
  const internalTables = await db.allDocs(
    getTableParams(null, {
      include_docs: true,
    })
  )

  // Filter by datasource and return the docs.
  const datasourceTableDocs = internalTables.rows.reduce((acc, table) => {
    if (table.doc.sourceId == datasourceId) {
      acc.push(table.doc)
    }
    return acc
  }, [])

  // Destroy the tables.
  for (const table of datasourceTableDocs) {
    await tableDestroy({
      params: {
        tableId: table._id,
      },
    })
  }
}

exports.destroy = async function (ctx) {
  const db = getAppDB()
  const datasourceId = ctx.params.datasourceId

  const datasource = await db.get(datasourceId)
  // Delete all queries for the datasource

  if (datasource.type === BUDIBASE_DATASOURCE_TYPE) {
    await destroyInternalTablesBySourceId(datasourceId)
  } else {
    const queries = await db.allDocs(getQueryParams(datasourceId, null))
    await db.bulkDocs(
      queries.rows.map(row => ({
        _id: row.id,
        _rev: row.value.rev,
        _deleted: true,
      }))
    )
  }

  // delete the datasource
  await db.remove(datasourceId, ctx.params.revId)
  await events.datasource.deleted(datasource)

  ctx.message = `Datasource deleted.`
  ctx.status = 200
}

exports.find = async function (ctx) {
  const database = getAppDB()
  ctx.body = await database.get(ctx.params.datasourceId)
}

// dynamic query functionality
exports.query = async function (ctx) {
  const queryJson = ctx.request.body
  try {
    ctx.body = await getDatasourceAndQuery(queryJson)
  } catch (err) {
    ctx.throw(400, err)
  }
}

function getErrorTables(errors, errorType) {
  return Object.entries(errors)
    .filter(entry => entry[1] === errorType)
    .map(([name]) => name)
}

function updateError(error, newError, tables) {
  if (!error) {
    error = ""
  }
  if (error.length > 0) {
    error += "\n"
  }
  error += `${newError} ${tables.join(", ")}`
  return error
}

const buildSchemaHelper = async datasource => {
  const Connector = await getIntegration(datasource.source)

  // Connect to the DB and build the schema
  const connector = new Connector(datasource.config)
  await connector.buildSchema(datasource._id, datasource.entities)

  const errors = connector.schemaErrors
  let error = null
  if (errors && Object.keys(errors).length > 0) {
    const noKey = getErrorTables(errors, BuildSchemaErrors.NO_KEY)
    const invalidCol = getErrorTables(errors, BuildSchemaErrors.INVALID_COLUMN)
    if (noKey.length) {
      error = updateError(
        error,
        "No primary key constraint found for the following:",
        noKey
      )
    }
    if (invalidCol.length) {
      const invalidCols = Object.values(InvalidColumns).join(", ")
      error = updateError(
        error,
        `Cannot use columns ${invalidCols} found in following:`,
        invalidCol
      )
    }
  }
  return { tables: connector.tables, error }
}
