import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards, Delete } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { TrainingService } from './training.service';
import { AuthUser } from '../../common/guards/branch-scope.util';

@ApiTags('Training')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RM, UserRole.BM, UserRole.ADMIN, UserRole.TRAINER)
@Controller({ path: 'training', version: '1' })
export class TrainingController {
  constructor(private readonly svc: TrainingService) {}

  @Get('batches')
  @ApiOperation({ summary: 'List all training batches (branch/RM scoped)' })
  listBatches(@Req() req: { user: AuthUser }) {
    return this.svc.listBatches(req.user);
  }

  @Post('batches')
  @ApiOperation({ summary: 'Create a new training batch' })
  createBatch(@Req() req: { user: AuthUser }, @Body() body: Record<string, unknown>) {
    return this.svc.createBatch(req.user, body);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Training dashboard stats' })
  getStats(@Req() req: { user: AuthUser }) {
    return this.svc.getStats(req.user);
  }

  @Post('batches/:batchId/enroll')
  @ApiOperation({ summary: 'Enroll a staff member in a batch' })
  enroll(
    @Param('batchId') batchId: string,
    @Body() body: { staff_id: string },
  ) {
    return this.svc.enrollStaff(batchId, body.staff_id);
  }

  @Patch('batches/:batchId/attendance')
  @ApiOperation({ summary: 'Mark attendance for a specific day' })
  markAttendance(
    @Param('batchId') batchId: string,
    @Body() body: { staff_id: string; day_number: number; attended: boolean },
  ) {
    return this.svc.markAttendance(batchId, body.staff_id, body.day_number, body.attended);
  }

  @Patch('batches/:batchId/status')
  @ApiOperation({ summary: 'Update batch status (UPCOMING/ACTIVE/COMPLETED)' })
  updateStatus(
    @Param('batchId') batchId: string,
    @Body() body: { status: string },
  ) {
    return this.svc.updateBatchStatus(batchId, body.status);
  }
  @Delete('batches/:batchId')
  @ApiOperation({ summary: 'Delete a training batch' })
  deleteBatch(@Param('batchId') batchId: string) {
    return this.svc.deleteBatch(batchId);
  }
}
