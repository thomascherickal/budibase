import { Document } from "../document"

export enum FieldType {
  STRING = "string",
  LONGFORM = "longform",
  OPTIONS = "options",
  NUMBER = "number",
  BOOLEAN = "boolean",
  ARRAY = "array",
  DATETIME = "datetime",
  ATTACHMENT = "attachment",
  LINK = "link",
  FORMULA = "formula",
  AUTO = "auto",
  JSON = "json",
  INTERNAL = "internal",
  BARCODEQR = "barcodeqr",
  BIGINT = "bigint",
}

export interface RowAttachment {
  size: number
  name: string
  extension: string
  key: string
  // Populated on read
  url?: string
}

export interface Row extends Document {
  type?: string
  tableId?: string
  [key: string]: any
}

export interface DeleteRows {
  rows: (Row | string)[]
}

export interface DeleteRow {
  _id: string
}

export type DeleteRowRequest = DeleteRows | DeleteRow
