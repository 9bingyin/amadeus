package schedule

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type cronExpr struct {
	minute cronField
	hour   cronField
	dom    cronField
	month  cronField
	dow    cronField
}

type cronField struct {
	wild   bool
	values map[int]struct{}
}

func parseCron(spec string) (cronExpr, error) {
	fields := strings.Fields(spec)
	if len(fields) != 5 {
		return cronExpr{}, fmt.Errorf("cron expression %q must have 5 fields", spec)
	}
	minute, err := parseCronField(fields[0], 0, 59)
	if err != nil {
		return cronExpr{}, fmt.Errorf("parse cron minute: %w", err)
	}
	hour, err := parseCronField(fields[1], 0, 23)
	if err != nil {
		return cronExpr{}, fmt.Errorf("parse cron hour: %w", err)
	}
	dom, err := parseCronField(fields[2], 1, 31)
	if err != nil {
		return cronExpr{}, fmt.Errorf("parse cron day: %w", err)
	}
	month, err := parseCronField(fields[3], 1, 12)
	if err != nil {
		return cronExpr{}, fmt.Errorf("parse cron month: %w", err)
	}
	dow, err := parseCronField(fields[4], 0, 7)
	if err != nil {
		return cronExpr{}, fmt.Errorf("parse cron weekday: %w", err)
	}
	if _, sunday := dow.values[7]; sunday {
		dow.values[0] = struct{}{}
		delete(dow.values, 7)
	}
	return cronExpr{minute: minute, hour: hour, dom: dom, month: month, dow: dow}, nil
}

func parseCronField(field string, minValue, maxValue int) (cronField, error) {
	if field == "*" {
		return cronField{wild: true, values: span(minValue, maxValue, 1)}, nil
	}
	values := map[int]struct{}{}
	for part := range strings.SplitSeq(field, ",") {
		if part == "" {
			return cronField{}, fmt.Errorf("field %q is invalid", field)
		}
		expanded, err := expandCronPart(part, minValue, maxValue)
		if err != nil {
			return cronField{}, err
		}
		for value := range expanded {
			values[value] = struct{}{}
		}
	}
	if len(values) == 0 {
		return cronField{}, fmt.Errorf("field %q is empty", field)
	}
	return cronField{values: values}, nil
}

func expandCronPart(part string, minValue, maxValue int) (map[int]struct{}, error) {
	step := 1
	base := part
	if before, after, found := strings.Cut(part, "/"); found {
		base = before
		parsed, err := strconv.Atoi(after)
		if err != nil || parsed < 1 {
			return nil, fmt.Errorf("field %q has an invalid step", part)
		}
		step = parsed
	}
	start, end := minValue, maxValue
	switch {
	case base == "*":
	case strings.Contains(base, "-"):
		left, right, _ := strings.Cut(base, "-")
		var err error
		start, err = strconv.Atoi(left)
		if err != nil {
			return nil, fmt.Errorf("field %q is invalid", part)
		}
		end, err = strconv.Atoi(right)
		if err != nil || start > end || start < minValue || end > maxValue {
			return nil, fmt.Errorf("field %q is out of range", part)
		}
	default:
		value, err := strconv.Atoi(base)
		if err != nil || value < minValue || value > maxValue {
			return nil, fmt.Errorf("field %q is out of range", part)
		}
		if step != 1 {
			end = maxValue
			start = value
			break
		}
		return map[int]struct{}{value: {}}, nil
	}
	if start < minValue || end > maxValue {
		return nil, fmt.Errorf("field %q is out of range", part)
	}
	return span(start, end, step), nil
}

func span(start, end, step int) map[int]struct{} {
	values := map[int]struct{}{}
	for value := start; value <= end; value += step {
		values[value] = struct{}{}
	}
	return values
}

func (e cronExpr) next(after time.Time) (time.Time, error) {
	candidate := after.In(time.Local).Truncate(time.Minute)
	if !candidate.After(after) {
		candidate = candidate.Add(time.Minute)
	}
	limit := candidate.AddDate(2, 0, 0)
	for !candidate.After(limit) {
		if e.matches(candidate) {
			return candidate, nil
		}
		candidate = candidate.Add(time.Minute)
	}
	return time.Time{}, fmt.Errorf("cron expression has no match within two years of %s", after.Format(time.RFC3339))
}

func (e cronExpr) matches(moment time.Time) bool {
	if !e.minute.has(moment.Minute()) || !e.hour.has(moment.Hour()) || !e.month.has(int(moment.Month())) {
		return false
	}
	dom := e.dom.has(moment.Day())
	dow := e.dow.has(int(moment.Weekday()))
	switch {
	case e.dom.wild && e.dow.wild:
		return true
	case e.dom.wild:
		return dow
	case e.dow.wild:
		return dom
	default:
		return dom || dow
	}
}

func (f cronField) has(value int) bool {
	_, ok := f.values[value]
	return ok
}

func normalizeCron(spec string) (string, error) {
	if _, err := parseCron(spec); err != nil {
		return "", err
	}
	return strings.Join(strings.Fields(spec), " "), nil
}
