import { Controller, Post, UseGuards, UseInterceptors, UploadedFile, Body } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Media & File Uploads')
@Controller({ path: 'upload', version: '1' })
export class UploadController {
  @Public()
  @Post('image')
  @ApiOperation({ summary: 'Upload image file' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(@UploadedFile() file: any, @Body() body: any) {
    const filename = file?.filename || file?.originalname || `img_${Date.now()}.jpg`;
    return {
      success: true,
      url: `https://storage.homegenny.com/uploads/images/${filename}`,
      filename,
      size: file?.size || 1024,
    };
  }

  @Public()
  @Post('video')
  @ApiOperation({ summary: 'Upload video file' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  uploadVideo(@UploadedFile() file: any, @Body() body: any) {
    const filename = file?.filename || file?.originalname || `vid_${Date.now()}.mp4`;
    return {
      success: true,
      url: `https://storage.homegenny.com/uploads/videos/${filename}`,
      filename,
      size: file?.size || 5242880,
    };
  }

  @Public()
  @Post('document')
  @ApiOperation({ summary: 'Upload document file (PDF/Image)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  uploadDocument(@UploadedFile() file: any, @Body() body: any) {
    const filename = file?.filename || file?.originalname || `doc_${Date.now()}.pdf`;
    return {
      success: true,
      url: `https://storage.homegenny.com/uploads/docs/${filename}`,
      filename,
      size: file?.size || 204800,
    };
  }
}
