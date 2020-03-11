import Excel, { Column, Worksheet, Workbook, Row, Cell } from 'exceljs';
import { validate } from 'class-validator';
import { columns } from './columns';
import { properties } from './properties';
import { ImportObservationsValidator } from './observation-format-validator';
import { CustomError } from '../../utils/CustomError';
import { parseValidationErrors } from '../../validation/validation-results-parser';

export interface RawData {
  [key: string]: {} | string;
}

export interface EURingError {
  rowNumber: number | null;
  status: RowErorr;
}

interface RowValidationError {
  result: {
    eu_species?: string[];
    eu_sexCode?: string[];
    eu_ageCode?: string[];
    eu_placeCode?: string[];
    date?: string[];
    latitude?: string[];
    longitude?: string[];
    eu_statusCode?: string[];
  };
  rowNumber?: number;
}

export interface RowValidatedData {
  data: RawData;
  rowNumber: number | null;
}

export interface RowErorr {
  verifiedEuRingCodes: boolean;
  error: string | null;
}

export interface DataCheckDto {
  emptyRowCount: number;
  rowCount: number;
  possibleClones: number;
  addedData: RowValidatedData[];
  observations: RawData[];
  importedCount: number;
  euRingErrors: EURingError[];
  invalidDataFormat: RowValidationError[];
}

export interface DataCheck extends DataCheckDto {
  validFormatData: RowValidatedData[];
}

const createColumns = (columnNames: string[]): Partial<Column>[] => {
  const createdColumns: Partial<Column>[] = [];

  if (columnNames) {
    columnNames.forEach(
      (name: string): void => {
        const extendedColumn = Object.assign({}, properties.colProperties, { header: name, key: name });
        createdColumns.push(extendedColumn);
      },
    );
  }

  return createdColumns;
};

const setStyleToRow = (row: Row, styles: Partial<Cell>): void => {
  row.eachCell(
    (cell: Cell): void => {
      // eslint-disable-next-line  no-param-reassign
      cell.style = styles;
    },
  );
};

export const createExcelWorkBook = async (type: string): Promise<Workbook> => {
  const workbook: Workbook = new Excel.Workbook();
  const worksheet: Worksheet = workbook.addWorksheet(properties.sheetName);
  const columnNames: string[] = columns[type];
  const columnNamesLength: number = columnNames ? columnNames.length : 0;
  const extendedFilter = Object.assign({}, properties.wsAutoFilter, { to: { row: 1, column: columnNamesLength } });

  workbook.properties = properties.wbProperties;
  workbook.views = properties.wbViews;

  worksheet.columns = createColumns(columnNames);
  worksheet.views = properties.wsViews;
  worksheet.autoFilter = extendedFilter;

  setStyleToRow(worksheet.getRow(1), properties.headerCellStyles);

  return workbook;
};

const getHeaderNames = (worksheet: Worksheet): string[] => {
  const headers: string[] = [];

  worksheet.getRow(1).eachCell(
    (cell: Cell): void => {
      if (cell.model.value) {
        headers.push(cell.model.value.toString());
      }
    },
  );

  return headers;
};

export const checkObservationsHeaderNames = async (workbook: Workbook, type: string): Promise<void> => {
  const columnNames = columns[type];
  const worksheet = workbook.getWorksheet(1);
  const errors: string[] = [];
  let excelHeaders: string[] = [];

  if (worksheet) {
    excelHeaders = getHeaderNames(worksheet);

    columnNames.filter(
      (name: string): boolean => {
        const isHeaderExists = excelHeaders.includes(name);

        if (isHeaderExists) {
          return isHeaderExists;
        }

        errors.push(name);

        return isHeaderExists;
      },
    );
  }

  if (errors.length > 0) {
    throw new CustomError(`Missed column titles: ${excelHeaders.join(',')}`, 400);
  }
};

/* eslint-disable */
const validateImportedData = async (data: any): Promise<any> => {
  const createdModel = await ImportObservationsValidator.create(data);
  const errors = await validate(createdModel);
  if (errors.length) {
    return parseValidationErrors(errors);
  }
};

export const checkObservationImportedData = async (workbook: Workbook): Promise<DataCheck> => {
  const worksheet = workbook.getWorksheet(1);
  const fileImportStatus: DataCheck = {
    emptyRowCount: 0,
    rowCount: 0,
    possibleClones: 0,
    addedData: [],
    observations: [],
    importedCount: 0,
    euRingErrors: [],
    validFormatData: [],
    invalidDataFormat: [],
  };
  let rowNumber = 2;
  if (worksheet) {
    fileImportStatus.rowCount = worksheet.rowCount - 1;
    const headers: string[] = getHeaderNames(worksheet);

    while (rowNumber <= worksheet.rowCount) {
      const rawData: RawData = {};
      const row = worksheet.getRow(rowNumber);

      if (row.values.length === 0) {
        fileImportStatus.emptyRowCount += 1;
        rowNumber += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      row.eachCell(
        (cell: Cell, index: number): void => {
          if (headers[index - 1] === 'date') {
            try {
              if (cell.model.value) {
                rawData[headers[index - 1]] = new Date(cell.model.value.toString()).toISOString();
              }
            } catch (e) {
              rawData[headers[index - 1]] = '';
            }
          } else if (headers[index - 1] === 'latitude' || headers[index - 1] === 'longitude') {
            // @ts-ignore
            rawData[headers[index - 1]] = +cell.model.value;
          } else if (cell.model.value) {
            rawData[headers[index - 1]] = cell.model.value.toString();
          }
        },
      );

      // eslint-disable-next-line no-await-in-loop
      const result = await validateImportedData(rawData);

      if (result) {
        const error: RowValidationError = { rowNumber, result };
        fileImportStatus.invalidDataFormat.push(error);
      } else {
        const data: RowValidatedData = { rowNumber, data: rawData };
        fileImportStatus.validFormatData.push(data);
      }

      rowNumber += 1;
    }
  }

  return fileImportStatus;
};

export type WorksheetParsingResult = { headers: string[]; data: object[] };
interface WorksheetParsingStatus {
  rowCount: number;
  emptyRowCount: number;
}

export const validateWorksheetColumnHeaders = (headers: string[], expectedHeaders: string[]): void => {
  const errors = expectedHeaders.reduce(
    (acc: string[], item: string) => (!headers.includes(item) ? acc.concat(item) : acc),
    [],
  );
  if (errors.length) {
    throw new CustomError(`Missed column titles: ${errors.join(', ')}`, 400);
  }
};

const worksheetParser = (
  worksheet: Worksheet,
  expectedHeaders: string[],
  status: WorksheetParsingStatus,
): WorksheetParsingResult => {
  let rowNumber = 1;
  const headers: string[] = [];
  const data: any[] = [];
  status.rowCount = worksheet.rowCount - 1;
  while (rowNumber <= worksheet.rowCount) {
    const row = worksheet.getRow(rowNumber);

    if (row.values.length === 0) {
      if (rowNumber === 1) {
        status.emptyRowCount += 1;
        throw new CustomError('Column headers are missed: parsing stopped', 400);
      }
      rowNumber += 1;
      continue;
    }

    let rowData: { [index: string]: any } = {};
    row.eachCell(
      (cell: Cell, index: number): void => {
        if (rowNumber === 1) {
          cell.model.value && headers.push(cell.model.value.toString());
        } else rowData[headers[index - 1]] = cell.model.value;
      },
    );
    rowNumber !== 1 && data.push(rowData);
    rowNumber += 1;
  }

  validateWorksheetColumnHeaders(headers, expectedHeaders);

  return Object.assign(status, { headers, data });
};

export const workbookParser = (
  workbook: Workbook,
  expectedHeaders: string[],
  status: WorksheetParsingStatus,
): WorksheetParsingResult[] => {
  const worksheet = workbook.getWorksheet(1);
  // README for a while parsed only first sheet, but returned array,
  //  like it were parsed all sheets in book. It's predefined contract
  return [worksheetParser(worksheet, expectedHeaders, status)];
};