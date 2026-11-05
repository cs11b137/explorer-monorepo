; ModuleID = 'sum.c'
source_filename = "sum.c"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-gnu"

@total = dso_local local_unnamed_addr global i32 0, align 4

; Function Attrs: nounwind
define dso_local i32 @sum(i32 noundef %n) local_unnamed_addr #0 {
entry:
  %cmp13 = icmp sgt i32 %n, 0
  br i1 %cmp13, label %while.end.loopexit, label %while.end

while.end.loopexit:                               ; preds = %entry
  %mul1 = mul i32 %n, 6
  %0 = add nsw i32 %n, -1
  %1 = or disjoint i32 %mul1, 1
  %2 = mul i32 %0, %1
  %3 = add i32 %2, %mul1
  %4 = zext i32 %0 to i33
  %5 = add nsw i32 %n, -2
  %6 = zext i32 %5 to i33
  %7 = mul i33 %4, %6
  %8 = lshr i33 %7, 1
  %9 = trunc nuw i33 %8 to i32
  %10 = add i32 %3, %9
  br label %while.end

while.end:                                        ; preds = %while.end.loopexit, %entry
  %s.0.lcssa = phi i32 [ 0, %entry ], [ %10, %while.end.loopexit ]
  store i32 %s.0.lcssa, ptr @total, align 4, !tbaa !4
  %call = tail call i32 @scale(i32 noundef %s.0.lcssa) #2
  %add5 = add nsw i32 %call, %n
  ret i32 %add5
}

declare i32 @scale(i32 noundef) local_unnamed_addr #1

attributes #0 = { nounwind "min-legal-vector-width"="0" "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #1 = { "no-builtins" "no-trapping-math"="true" "stack-protector-buffer-size"="8" "target-cpu"="x86-64" "target-features"="+cmov,+cx8,+fxsr,+mmx,+sse,+sse2,+x87" "tune-cpu"="generic" }
attributes #2 = { nobuiltin nounwind "no-builtins" }

!llvm.module.flags = !{!0, !1, !2}
!llvm.ident = !{!3}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{i32 8, !"PIC Level", i32 2}
!2 = !{i32 7, !"PIE Level", i32 2}
!3 = !{!"Apple clang version 21.0.0 (clang-2100.4.1.1)"}
!4 = !{!5, !5, i64 0}
!5 = !{!"int", !6, i64 0}
!6 = !{!"omnipotent char", !7, i64 0}
!7 = !{!"Simple C/C++ TBAA"}
