import { PDFDocument, StandardFonts } from "pdf-lib";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

export async function createPdfBuffer(title: string, content: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;
  const margin = 50;

  let page = pdfDoc.addPage();
  let { width, height } = page.getSize();
  let y = height - margin;

  page.drawText(title, { x: margin, y, size: 20, font });
  y -= 40;

  const maxWidth = width - margin * 2;
  const words = content.split(/\s+/);
  let line = "";
  const lines: string[] = [];

  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    const testWidth = font.widthOfTextAtSize(testLine, fontSize);
    if (testWidth > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = testLine;
    }
  }
  if (line) lines.push(line);

  for (const l of lines) {
    if (y < margin) {
      page = pdfDoc.addPage();
      ({ width, height } = page.getSize());
      y = height - margin;
    }
    page.drawText(l, { x: margin, y, size: fontSize, font });
    y -= fontSize + 4;
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

export async function createDocxBuffer(title: string, content: string): Promise<Buffer> {
  const paragraphs = content
    .split("\n")
    .map((line) => new Paragraph({ children: [new TextRun(line)] }));

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          ...paragraphs,
        ],
      },
    ],
  });
  import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";

export async function createXlsxBuffer(title: string, rows: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.slice(0, 31) || "Sheet1");

  rows.forEach((row) => {
    sheet.addRow(row);
  });

  if (rows.length > 0) {
    sheet.getRow(1).font = { bold: true };
  }
  sheet.columns.forEach((column) => {
    column.width = 20;
  });

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export async function createPptxBuffer(title: string, slidesText: string[]): Promise<Buffer> {
  const pptx = new PptxGenJS();

  const titleSlide = pptx.addSlide();
  titleSlide.addText(title, {
    x: 0.5, y: 2, w: "90%", h: 1.5,
    fontSize: 32, bold: true, align: "center",
  });

  slidesText.forEach((text, index) => {
    const slide = pptx.addSlide();
    slide.addText(`Slide ${index + 1}`, {
      x: 0.5, y: 0.3, w: "90%", h: 0.7, fontSize: 24, bold: true,
    });
    slide.addText(text, {
      x: 0.5, y: 1.2, w: "90%", h: 4, fontSize: 18,
    });
  });

  const data = await pptx.write({ outputType: "nodebuffer" });
  return data as Buffer;
}

  return Packer.toBuffer(doc);
}
