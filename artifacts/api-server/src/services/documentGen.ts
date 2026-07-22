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

  return Packer.toBuffer(doc);
}
