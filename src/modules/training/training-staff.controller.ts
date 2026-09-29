import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Roles, UserRole } from '../auth/decorators/roles.decorator';
import { TrainingQuizService } from './training-quiz.service';

interface AuthedRequest { user: { id: string; phone: string } }

@ApiTags('Training', 'Mobile App Staff APIs')
@ApiBearerAuth()
@Controller({ path: 'training', version: '1' })
export class TrainingStaffController {
  constructor(private readonly quizzes: TrainingQuizService) {}

  @Get('mine')
  @Roles(UserRole.STAFF)
  @ApiOperation({
    summary: 'Staff app training home — my batches (schedule, trainer), study material, quizzes, and video-cert progress',
    description: 'Not filtered by pipeline stage: a staff who moved on to S4/S5 still sees their training and any rescheduled quiz.',
  })
  async mine(@Req() req: AuthedRequest) {
    const staffId = await this.quizzes.resolveStaffApplicantId(req.user.id, req.user.phone);
    return this.quizzes.getMyTraining(staffId);
  }
}
