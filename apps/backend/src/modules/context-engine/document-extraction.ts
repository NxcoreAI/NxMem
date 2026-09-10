import { inflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";

export interface DocumentExtractionResult {
  content?: string;
  status: "extracted" | "unsupported" | "empty" | "failed";
  reason?: string;
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const endOfCentralDirectorySignature = 0x06054b50;
const centralDirectoryFileHeaderSignature = 0x02014b50;
const localFileHeaderSignature = 0x04034b50;
const maxEndOfCentralDirectorySearch = 65_557;

export async function extractDocumentContent(
  path: string,
  extension: string
): Promise<DocumentExtractionResult> {
  if (extension !== ".docx") {
    return { status: "unsupported", reason: `unsupported_document_format:${extension}` };
  }

  try {
    const archive = await readFile(path);
    const documentXml = readZipTextEntry(archive, "word/document.xml");

    if (!documentXml) {
      return { status: "failed", reason: "docx_document_xml_not_found" };
    }

    const content = extractTextFromWordXml(documentXml);
    if (!content) {
      return { status: "empty", reason: "docx_text_empty" };
    }

    return { status: "extracted", content };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "document_extraction_failed"
    };
  }
}

function readZipTextEntry(archive: Buffer, entryName: string): string | undefined {
  const entry = findZipEntry(archive, entryName);
  if (!entry) return undefined;

  const localHeader = entry.localHeaderOffset;
  if (archive.readUInt32LE(localHeader) !== localFileHeaderSignature) {
    throw new Error("invalid_zip_local_header");
  }

  const fileNameLength = archive.readUInt16LE(localHeader + 26);
  const extraFieldLength = archive.readUInt16LE(localHeader + 28);
  const dataOffset = localHeader + 30 + fileNameLength + extraFieldLength;
  const compressedData = archive.subarray(dataOffset, dataOffset + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressedData.toString("utf8");
  }

  if (entry.compressionMethod === 8) {
    return inflateRawSync(compressedData, { finishFlush: 2 }).toString("utf8");
  }

  throw new Error(`unsupported_zip_compression:${entry.compressionMethod}`);
}

function findZipEntry(archive: Buffer, entryName: string): ZipEntry | undefined {
  const centralDirectoryOffset = findCentralDirectoryOffset(archive);
  let offset = centralDirectoryOffset;

  while (offset < archive.length) {
    if (archive.readUInt32LE(offset) !== centralDirectoryFileHeaderSignature) break;

    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraFieldLength = archive.readUInt16LE(offset + 30);
    const fileCommentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = archive.subarray(nameStart, nameStart + fileNameLength).toString("utf8");

    if (name === entryName) {
      return {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset
      };
    }

    offset = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }

  return undefined;
}

function findCentralDirectoryOffset(archive: Buffer): number {
  const start = Math.max(0, archive.length - maxEndOfCentralDirectorySearch);

  for (let offset = archive.length - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      return archive.readUInt32LE(offset + 16);
    }
  }

  throw new Error("zip_central_directory_not_found");
}

function extractTextFromWordXml(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
