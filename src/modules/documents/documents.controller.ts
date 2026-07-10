import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentsService } from './documents.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';

@ApiTags('Employee Documents')
@ApiBearerAuth()
@Controller({ path: 'documents', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  @Post(':employeeId/upload')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload or replace a document for an employee' })
  async upload(
    @Param('employeeId') employeeId: string,
    @Body('type') type: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('docNumber') docNumber?: string,
    @Body('issueDate') issueDate?: string,
    @Body('issuedBy') issuedBy?: string,
    @Body('validFrom') validFrom?: string,
    @Body('validTill') validTill?: string,
  ) {
    return this.service.upload(employeeId, type, file, {
      docNumber,
      issueDate,
      issuedBy,
      validFrom,
      validTill,
    });
  }

  @Get('employee/:employeeId')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get all uploaded documents for an employee' })
  async findByEmployee(@Param('employeeId') employeeId: string) {
    return this.service.findByEmployee(employeeId);
  }

  @Get(':id/preview')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Preview document in browser' })
  async preview(@Param('id') id: string, @Res() res: Response) {
    const { fullPath, mimeType } = await this.service.getFileDetails(id);
    res.setHeader('Content-Type', mimeType);
    return res.sendFile(fullPath);
  }

  @Get(':id/download')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Download document file' })
  async download(@Param('id') id: string, @Res() res: Response) {
    const { fullPath, originalName } = await this.service.getFileDetails(id);
    res.download(fullPath, originalName);
  }

  @Delete(':id')
  @Roles(UserRole.HR, UserRole.ADMIN)
  @ApiOperation({ summary: 'Delete document' })
  async delete(@Param('id') id: string) {
    return this.service.delete(id);
  }
}
