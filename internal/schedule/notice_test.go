package schedule

import "testing"

func TestJobIdentity(t *testing.T) {
	got := jobIdentity(1, "点外卖[提醒]")
	want := "Schedule #1 点外卖 提醒"
	if got != want {
		t.Fatalf("jobIdentity() = %q, want %q", got, want)
	}
}
