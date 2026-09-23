package telegram

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/9bingyin/amadeus/internal/gateway"
	"github.com/go-telegram/bot/models"
)

func (s *Service) composeRichMessage(
	ctx context.Context,
	message *models.Message,
) (string, []gateway.Attachment, error) {
	var attachments []gateway.Attachment
	text, err := renderRichBlocks(message.RichMessage.Blocks, func(block models.RichBlock) (string, error) {
		line, saved, saveErr := s.saveRichMedia(ctx, message, block)
		if saveErr != nil {
			return "", saveErr
		}
		attachments = append(attachments, saved...)
		return line, nil
	})
	if err != nil {
		return "", nil, err
	}
	return text, attachments, nil
}

func (s *Service) saveRichMedia(
	ctx context.Context,
	message *models.Message,
	block models.RichBlock,
) (string, []gateway.Attachment, error) {
	switch block.Type {
	case models.RichBlockTypePhoto:
		if block.RichBlockPhoto == nil {
			return "", nil, nil
		}
		return s.savePhotoSizes(ctx, message, block.RichBlockPhoto.Photo)
	case models.RichBlockTypeDocument:
		if block.RichBlockDocument == nil {
			return "", nil, nil
		}
		return s.saveDocumentValue(ctx, message, &block.RichBlockDocument.Document)
	case models.RichBlockTypeVideo:
		if block.RichBlockVideo == nil {
			return "", nil, nil
		}
		video := block.RichBlockVideo.Video
		name := strings.TrimSpace(video.FileName)
		if name == "" {
			name = "video.mp4"
		}
		return s.saveKeptFile(ctx, message, "video", video.FileID, video.FileUniqueID, name, video.MimeType, video.FileSize)
	case models.RichBlockTypeAudio:
		if block.RichBlockAudio == nil {
			return "", nil, nil
		}
		audio := block.RichBlockAudio.Audio
		name := strings.TrimSpace(audio.FileName)
		if name == "" {
			name = "audio.mp3"
		}
		return s.saveKeptFile(ctx, message, "audio", audio.FileID, audio.FileUniqueID, name, audio.MimeType, audio.FileSize)
	case models.RichBlockTypeVoiceNote:
		if block.RichBlockVoiceNote == nil {
			return "", nil, nil
		}
		voice := block.RichBlockVoiceNote.VoiceNote
		return s.saveKeptFile(ctx, message, "audio", voice.FileID, voice.FileUniqueID, "voice.ogg", voice.MimeType, int64(voice.FileSize))
	case models.RichBlockTypeAnimation:
		return "[animation]", nil, nil
	default:
		return "", nil, nil
	}
}

func (s *Service) savePhotoSizes(
	ctx context.Context,
	message *models.Message,
	photos []models.PhotoSize,
) (string, []gateway.Attachment, error) {
	if len(photos) == 0 {
		return "[image attachment unavailable]", nil, nil
	}
	photo := largestPhoto(photos)
	filename := attachmentFileName(message.ID, photo.FileUniqueID, "photo.jpg")
	dest, saved, err := s.saveNamedFile(ctx, message.Chat.ID, filename, photo.FileID, int64(photo.FileSize))
	if err != nil {
		return "", nil, err
	}
	if !saved {
		return "[image attachment unavailable]", nil, nil
	}
	return s.nativeOrPathLine("image", dest, "image/jpeg", "photo.jpg")
}

func (s *Service) saveDocumentValue(
	ctx context.Context,
	message *models.Message,
	document *models.Document,
) (string, []gateway.Attachment, error) {
	original := strings.TrimSpace(document.FileName)
	filename := attachmentFileName(message.ID, document.FileUniqueID, original)
	dest, saved, err := s.saveNamedFile(ctx, message.Chat.ID, filename, document.FileID, document.FileSize)
	if err != nil {
		return "", nil, err
	}
	if !saved {
		return "[document attachment unavailable]", nil, nil
	}
	if original == "" {
		original = filepath.Base(dest)
	}
	mediaType := detectSavedMediaType(dest, document.MimeType, original)
	kind := "document"
	if strings.HasPrefix(mediaType, "image/") {
		kind = "image"
	}
	return s.nativeOrPathLine(kind, dest, mediaType, original)
}

func renderRichBlocks(blocks []models.RichBlock, media func(models.RichBlock) (string, error)) (string, error) {
	var lines []string
	for _, block := range blocks {
		line, err := renderRichBlock(block, media)
		if err != nil {
			return "", err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n"), nil
}

func renderRichBlock(block models.RichBlock, media func(models.RichBlock) (string, error)) (string, error) {
	switch block.Type {
	case models.RichBlockTypeParagraph:
		if block.RichBlockParagraph == nil {
			return "", nil
		}
		return renderRichText(block.RichBlockParagraph.Text), nil
	case models.RichBlockTypeSectionHeading:
		if block.RichBlockSectionHeading == nil {
			return "", nil
		}
		return renderRichText(block.RichBlockSectionHeading.Text), nil
	case models.RichBlockTypePreformatted:
		if block.RichBlockPreformatted == nil {
			return "", nil
		}
		return renderRichText(block.RichBlockPreformatted.Text), nil
	case models.RichBlockTypeFooter:
		if block.RichBlockFooter == nil {
			return "", nil
		}
		return renderRichText(block.RichBlockFooter.Text), nil
	case models.RichBlockTypeMathematicalExpression:
		if block.RichBlockMathematicalExpression == nil {
			return "", nil
		}
		return block.RichBlockMathematicalExpression.Expression, nil
	case models.RichBlockTypeList:
		if block.RichBlockList == nil {
			return "", nil
		}
		return renderRichList(block.RichBlockList.Items, media)
	case models.RichBlockTypeBlockQuotation:
		if block.RichBlockBlockQuotation == nil {
			return "", nil
		}
		body, err := renderRichBlocks(block.RichBlockBlockQuotation.Blocks, media)
		if err != nil {
			return "", err
		}
		return joinRichParts(body, renderOptionalRichText(block.RichBlockBlockQuotation.Credit)), nil
	case models.RichBlockTypeExpandableBlockQuotation:
		if block.RichBlockExpandableBlockQuotation == nil {
			return "", nil
		}
		quote := block.RichBlockExpandableBlockQuotation
		return joinRichParts(renderRichText(quote.Text), renderOptionalRichText(quote.Credit)), nil
	case models.RichBlockTypePullQuotation:
		if block.RichBlockPullQuotation == nil {
			return "", nil
		}
		quote := block.RichBlockPullQuotation
		return joinRichParts(renderRichText(quote.Text), renderOptionalRichText(quote.Credit)), nil
	case models.RichBlockTypeCollage:
		if block.RichBlockCollage == nil {
			return "", nil
		}
		body, err := renderRichBlocks(block.RichBlockCollage.Blocks, media)
		if err != nil {
			return "", err
		}
		return joinRichParts(richCaption(block.RichBlockCollage.Caption), body), nil
	case models.RichBlockTypeSlideshow:
		if block.RichBlockSlideshow == nil {
			return "", nil
		}
		body, err := renderRichBlocks(block.RichBlockSlideshow.Blocks, media)
		if err != nil {
			return "", err
		}
		return joinRichParts(richCaption(block.RichBlockSlideshow.Caption), body), nil
	case models.RichBlockTypeTable:
		if block.RichBlockTable == nil {
			return "", nil
		}
		return renderRichTable(block.RichBlockTable), nil
	case models.RichBlockTypeDetails:
		if block.RichBlockDetails == nil {
			return "", nil
		}
		body, err := renderRichBlocks(block.RichBlockDetails.Blocks, media)
		if err != nil {
			return "", err
		}
		return joinRichParts(renderRichText(block.RichBlockDetails.Summary), body), nil
	case models.RichBlockTypeMap:
		if block.RichBlockMap == nil {
			return "", nil
		}
		return joinRichParts(formatLocation(&block.RichBlockMap.Location), richCaption(block.RichBlockMap.Caption)), nil
	case models.RichBlockTypeButtons:
		if block.RichBlockButtons == nil {
			return "", nil
		}
		var labels []string
		for _, button := range block.RichBlockButtons.Buttons {
			if label := renderRichButton(button); label != "" {
				labels = append(labels, label)
			}
		}
		return strings.Join(labels, "\n"), nil
	case models.RichBlockTypeThinking:
		if block.RichBlockThinking == nil {
			return "", nil
		}
		return renderRichText(block.RichBlockThinking.Text), nil
	case models.RichBlockTypePhoto, models.RichBlockTypeDocument, models.RichBlockTypeVideo,
		models.RichBlockTypeAudio, models.RichBlockTypeVoiceNote, models.RichBlockTypeAnimation:
		line, err := richMediaLine(block, media)
		if err != nil {
			return "", err
		}
		return joinRichParts(richBlockCaption(block), line), nil
	default:
		return "", nil
	}
}

func renderRichList(items []models.RichBlockListItem, media func(models.RichBlock) (string, error)) (string, error) {
	var lines []string
	for _, item := range items {
		body, err := renderRichBlocks(item.Blocks, media)
		if err != nil {
			return "", err
		}
		line := strings.TrimSpace(body)
		label := strings.TrimSpace(item.Label)
		switch {
		case label != "" && line != "":
			line = label + " " + line
		case label != "":
			line = label
		}
		if line != "" {
			lines = append(lines, "- "+line)
		}
	}
	return strings.Join(lines, "\n"), nil
}

func renderRichTable(table *models.RichBlockTable) string {
	var rows []string
	if caption := strings.TrimSpace(renderOptionalRichText(table.Caption)); caption != "" {
		rows = append(rows, caption)
	}
	for _, row := range table.Cells {
		var cells []string
		for _, cell := range row {
			cells = append(cells, strings.TrimSpace(renderOptionalRichText(cell.Text)))
		}
		rows = append(rows, strings.Join(cells, " | "))
	}
	return strings.Join(rows, "\n")
}

func richMediaLine(block models.RichBlock, media func(models.RichBlock) (string, error)) (string, error) {
	if media != nil {
		return media(block)
	}
	switch block.Type {
	case models.RichBlockTypePhoto:
		return "[image]", nil
	case models.RichBlockTypeDocument:
		return "[document]", nil
	case models.RichBlockTypeVideo:
		return "[video]", nil
	case models.RichBlockTypeAudio, models.RichBlockTypeVoiceNote:
		return "[audio]", nil
	case models.RichBlockTypeAnimation:
		return "[animation]", nil
	default:
		return "", nil
	}
}

func richBlockCaption(block models.RichBlock) string {
	switch block.Type {
	case models.RichBlockTypePhoto:
		if block.RichBlockPhoto != nil {
			return richCaption(block.RichBlockPhoto.Caption)
		}
	case models.RichBlockTypeDocument:
		if block.RichBlockDocument != nil {
			return richCaption(block.RichBlockDocument.Caption)
		}
	case models.RichBlockTypeVideo:
		if block.RichBlockVideo != nil {
			return richCaption(block.RichBlockVideo.Caption)
		}
	case models.RichBlockTypeAudio:
		if block.RichBlockAudio != nil {
			return richCaption(block.RichBlockAudio.Caption)
		}
	case models.RichBlockTypeVoiceNote:
		if block.RichBlockVoiceNote != nil {
			return richCaption(block.RichBlockVoiceNote.Caption)
		}
	case models.RichBlockTypeAnimation:
		if block.RichBlockAnimation != nil {
			return richCaption(block.RichBlockAnimation.Caption)
		}
	}
	return ""
}

func richCaption(caption *models.RichBlockCaption) string {
	if caption == nil {
		return ""
	}
	return joinRichParts(renderRichText(caption.Text), renderOptionalRichText(caption.Credit))
}

func renderOptionalRichText(text *models.RichText) string {
	if text == nil {
		return ""
	}
	return renderRichText(*text)
}

func renderRichButton(button models.RichMessageButton) string {
	return renderLabeled(button.Text, button.URL)
}

func renderRichText(text models.RichText) string {
	if len(text.Array) > 0 {
		var builder strings.Builder
		for _, part := range text.Array {
			builder.WriteString(renderRichText(part))
		}
		return builder.String()
	}
	switch text.Type {
	case "":
		return text.PlainText
	case models.RichTextTypeBold:
		if text.RichTextBold == nil {
			return ""
		}
		return renderRichText(text.RichTextBold.Text)
	case models.RichTextTypeItalic:
		if text.RichTextItalic == nil {
			return ""
		}
		return renderRichText(text.RichTextItalic.Text)
	case models.RichTextTypeUnderline:
		if text.RichTextUnderline == nil {
			return ""
		}
		return renderRichText(text.RichTextUnderline.Text)
	case models.RichTextTypeStrikethrough:
		if text.RichTextStrikethrough == nil {
			return ""
		}
		return renderRichText(text.RichTextStrikethrough.Text)
	case models.RichTextTypeSpoiler:
		if text.RichTextSpoiler == nil {
			return ""
		}
		return renderRichText(text.RichTextSpoiler.Text)
	case models.RichTextTypeSubscript:
		if text.RichTextSubscript == nil {
			return ""
		}
		return renderRichText(text.RichTextSubscript.Text)
	case models.RichTextTypeSuperscript:
		if text.RichTextSuperscript == nil {
			return ""
		}
		return renderRichText(text.RichTextSuperscript.Text)
	case models.RichTextTypeMarked:
		if text.RichTextMarked == nil {
			return ""
		}
		return renderRichText(text.RichTextMarked.Text)
	case models.RichTextTypeCode:
		if text.RichTextCode == nil {
			return ""
		}
		return renderRichText(text.RichTextCode.Text)
	case models.RichTextTypeDateTime:
		if text.RichTextDateTime == nil {
			return ""
		}
		return renderRichText(text.RichTextDateTime.Text)
	case models.RichTextTypeTextMention:
		if text.RichTextTextMention == nil {
			return ""
		}
		return renderLabeled(text.RichTextTextMention.Text, senderLabel(text.RichTextTextMention.User))
	case models.RichTextTypeCustomEmoji:
		if text.RichTextCustomEmoji == nil {
			return ""
		}
		return text.RichTextCustomEmoji.AlternativeText
	case models.RichTextTypeMathematicalExpression:
		if text.RichTextMathematicalExpression == nil {
			return ""
		}
		return text.RichTextMathematicalExpression.Expression
	case models.RichTextTypeURL:
		if text.RichTextURL == nil {
			return ""
		}
		return renderLabeled(text.RichTextURL.Text, text.RichTextURL.URL)
	case models.RichTextTypeEmailAddress:
		if text.RichTextEmailAddress == nil {
			return ""
		}
		return renderLabeled(text.RichTextEmailAddress.Text, text.RichTextEmailAddress.EmailAddress)
	case models.RichTextTypePhoneNumber:
		if text.RichTextPhoneNumber == nil {
			return ""
		}
		return renderLabeled(text.RichTextPhoneNumber.Text, text.RichTextPhoneNumber.PhoneNumber)
	case models.RichTextTypeBankCardNumber:
		if text.RichTextBankCardNumber == nil {
			return ""
		}
		return renderLabeled(text.RichTextBankCardNumber.Text, text.RichTextBankCardNumber.BankCardNumber)
	case models.RichTextTypeMention:
		if text.RichTextMention == nil {
			return ""
		}
		username := strings.TrimSpace(text.RichTextMention.Username)
		if username != "" && !strings.HasPrefix(username, "@") {
			username = "@" + username
		}
		return renderLabeled(text.RichTextMention.Text, username)
	case models.RichTextTypeHashtag:
		if text.RichTextHashtag == nil {
			return ""
		}
		return renderLabeled(text.RichTextHashtag.Text, text.RichTextHashtag.Hashtag)
	case models.RichTextTypeCashtag:
		if text.RichTextCashtag == nil {
			return ""
		}
		return renderLabeled(text.RichTextCashtag.Text, text.RichTextCashtag.Cashtag)
	case models.RichTextTypeBotCommand:
		if text.RichTextBotCommand == nil {
			return ""
		}
		return renderLabeled(text.RichTextBotCommand.Text, text.RichTextBotCommand.BotCommand)
	case models.RichTextTypeButton:
		if text.RichTextButton == nil {
			return ""
		}
		return renderRichButton(text.RichTextButton.Button)
	case models.RichTextTypeAnchorLink:
		if text.RichTextAnchorLink == nil {
			return ""
		}
		return renderRichText(text.RichTextAnchorLink.Text)
	case models.RichTextTypeReference:
		if text.RichTextReference == nil {
			return ""
		}
		return renderRichText(text.RichTextReference.Text)
	case models.RichTextTypeReferenceLink:
		if text.RichTextReferenceLink == nil {
			return ""
		}
		return renderRichText(text.RichTextReferenceLink.Text)
	default:
		return ""
	}
}

func renderLabeled(text models.RichText, extra string) string {
	label := strings.TrimSpace(renderRichText(text))
	extra = strings.TrimSpace(extra)
	switch {
	case label != "" && extra != "" && label != extra:
		return label + " (" + extra + ")"
	case label != "":
		return label
	default:
		return extra
	}
}

func joinRichParts(parts ...string) string {
	var lines []string
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		lines = append(lines, part)
	}
	return strings.Join(lines, "\n")
}
