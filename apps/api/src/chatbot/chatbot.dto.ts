import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';

export class ChatMessageDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Length(1, 2000)
  content: string;
}

export class ChatRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(9)
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];
}
