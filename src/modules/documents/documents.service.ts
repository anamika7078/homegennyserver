import { Injectable, BadRequestException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { DocumentsRepository } from './documents.repository';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class DocumentsService implements OnModuleInit {
  private readonly uploadDir = path.join(process.cwd(), 'uploads', 'employees');

  constructor(private readonly repo: DocumentsRepository) {}

  onModuleInit() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  calculateStatus(validTill?: Date | null): string {
    if (!validTill) return 'Verified';
    const today = new Date();
    const expiry = new Date(validTill);
    const diffTime = expiry.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return 'Expired';
    } else if (diffDays <= 30) {
      return 'Expiring Soon';
    }
    return 'Verified';
  }

  validateFormat(type: string, docNumber?: string) {
    if (!docNumber) return;
    if (type === 'Aadhaar Card') {
      const cleaned = docNumber.replace(/\s/g, '');
      if (!/^\d{12}$/.test(cleaned)) {
        throw new BadRequestException('Aadhaar Card must be a 12-digit number');
      }
    } else if (type === 'PAN Card') {
      const cleaned = docNumber.toUpperCase().trim();
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(cleaned)) {
        throw new BadRequestException('PAN Card format must be valid (e.g. ABCDE1234F)');
      }
    }
  }

  getMandatoryDocumentTypes(categoryName: string): string[] {
    const common = ['Aadhaar Card', 'Passport Size Photo', 'Police Verification Certificate'];
    const standard = ['Aadhaar Card', 'PAN Card', 'Passport Size Photo', 'Police Verification Certificate'];

    switch (categoryName) {
      case 'Driver':
        return [...standard, 'Driving License'];
      case 'Maid':
        return common;
      case 'Caretaker':
        return [...standard, 'Medical Certificate'];
      case 'Cook':
      case 'Security Guard':
      default:
        return standard;
    }
  }

  async getMissingDocuments(employee: any): Promise<string[]> {
    const mandatory = this.getMandatoryDocumentTypes(employee.category.name);
    const docs = await this.repo.findByEmployeeId(employee.id);
    const uploadedTypes = docs.map((d) => d.type);
    return mandatory.filter((m) => !uploadedTypes.includes(m));
  }

  async upload(
    employeeId: string,
    type: string,
    file: Express.Multer.File,
    fields: {
      docNumber?: string;
      issueDate?: string;
      issuedBy?: string;
      validFrom?: string;
      validTill?: string;
    },
  ) {
    if (!file) {
      throw new BadRequestException('No document file uploaded');
    }

    // Size limit check: 5 MB
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new BadRequestException('Document exceeds maximum size limit of 5 MB');
    }

    // MIME type check
    const allowedMimeTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Only PDF, JPG, JPEG, and PNG formats are supported');
    }

    // Validate format for Aadhaar / PAN
    this.validateFormat(type, fields.docNumber);

    // If document already exists of this type for employee, overwrite it (replace)
    const existing = await this.repo.findByEmployeeAndType(employeeId, type);
    if (existing) {
      // Delete old file
      const oldFilePath = path.join(process.cwd(), existing.fileUrl);
      if (fs.existsSync(oldFilePath)) {
        try {
          fs.unlinkSync(oldFilePath);
        } catch {}
      }
      await this.repo.delete(existing.id);
    }

    // Save file locally
    const filename = `${employeeId}_${Date.now()}_${type.replace(/\s+/g, '_')}${path.extname(file.originalname)}`;
    const filePath = path.join(this.uploadDir, filename);
    fs.writeFileSync(filePath, file.buffer);

    const relativeUrl = `uploads/employees/${filename}`;

    const validTill = fields.validTill ? new Date(fields.validTill) : null;
    const status = this.calculateStatus(validTill);

    const createData: Prisma.EmployeeDocumentCreateInput = {
      type,
      docNumber: fields.docNumber || null,
      fileUrl: relativeUrl,
      issueDate: fields.issueDate ? new Date(fields.issueDate) : null,
      issuedBy: fields.issuedBy || null,
      validFrom: fields.validFrom ? new Date(fields.validFrom) : null,
      validTill: validTill,
      status,
      employee: { connect: { id: employeeId } },
      metadata: {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
    };

    return this.repo.create(createData);
  }

  async findByEmployee(employeeId: string) {
    return this.repo.findByEmployeeId(employeeId);
  }

  async findOne(id: string) {
    const doc = await this.repo.findById(id);
    if (!doc) {
      throw new NotFoundException(`Document with ID ${id} not found`);
    }
    return doc;
  }

  async getFileDetails(id: string) {
    const doc = await this.findOne(id);
    const fullPath = path.join(process.cwd(), doc.fileUrl);
    if (!fs.existsSync(fullPath)) {
      throw new NotFoundException('Document file not found on disk');
    }
    return {
      doc,
      fullPath,
      mimeType: (doc.metadata as any)?.mimeType || 'application/octet-stream',
      originalName: (doc.metadata as any)?.originalName || 'file',
    };
  }

  async delete(id: string) {
    const doc = await this.findOne(id);
    const fullPath = path.join(process.cwd(), doc.fileUrl);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
      } catch {}
    }
    return this.repo.delete(id);
  }

  async refreshStatuses() {
    const docs = await this.repo.findExpiringDocuments('Driving License', 365); // Refresh all that have expiry dates
    const docs2 = await this.repo.findExpiringDocuments('Police Verification Certificate', 365);
    const all = [...docs, ...docs2];
    for (const doc of all) {
      const newStatus = this.calculateStatus(doc.validTill);
      if (newStatus !== doc.status) {
        await this.repo.update(doc.id, { status: newStatus });
      }
    }
  }
}
